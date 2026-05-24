# Tài liệu dự án Backend - RentPay Manager

Tài liệu này mô tả trạng thái backend hiện tại để các agent/dev sau này cập nhật tiếp khi thêm chức năng hoặc đổi logic. Backend nằm trong thư mục `BE`, viết bằng NestJS, Prisma, PostgreSQL và Redis.

## 1. Tổng quan kiến trúc

- Framework: NestJS 11, TypeScript.
- Database: PostgreSQL qua Prisma Client. Schema chính ở `prisma/schema.prisma`, migration ở `prisma/migrations`.
- Cache/rate-limit/session mirror: Redis qua `src/redis/redis.service.ts`. Nếu không có `REDIS_URL` hoặc Redis lỗi, backend vẫn chạy; rate-limit fallback về memory, cache/session mirror bị bỏ qua.
- Auth: JWT access token và refresh token lưu bằng httpOnly cookie. Access cookie path `/`, refresh cookie path `/api/auth`.
- API prefix: toàn bộ HTTP API dùng prefix `/api` từ `src/main.ts`.
- CORS: chỉ mở theo `CLIENT_URL`, mặc định `http://localhost:5173`, có `credentials: true`.
- Validation global: `ValidationPipe` bật `whitelist`, `transform`, không chặn field lạ (`forbidNonWhitelisted: false`). Hiện phần lớn controller nhận `body/query: any`, validate nghiệp vụ nằm trong service.
- Realtime: Socket.IO gateway phát event theo tên `business:{businessId}:{event}`.
- Guard/interceptor global:
  - `JwtAuthGuard`: bắt buộc JWT trừ endpoint có `@Public()`.
  - `RolesGuard`: kiểm tra `@Roles(...)`.
  - `RateLimitGuard`: mặc định read 300 req/phút, write 120 req/phút, public 60 req/phút; một số endpoint override.
  - `RetryInterceptor`: retry endpoint có `@Retryable()` khi lỗi transient.

Module chính được import trong `AppModule`: Auth, Users, Businesses, BankAccounts, BankConnections, RoomAreas, Rooms, Tenants, Contracts, BillingPeriods, Charges, Payments, TenantCredits, TenantCreditActivities, BankTransactions, Dashboard, Reports, PublicPortal, NotificationLogs, Audit, Prisma, Redis, Realtime.

## 2. Domain/model chính

Các enum quan trọng:

- `Role`: `SUPER_ADMIN`, `BUSINESS_OWNER`, `STAFF`.
- `RoomStatus`: `AVAILABLE`, `DEPOSITED`, `OCCUPIED`, `MAINTENANCE`, `INACTIVE`.
- `TenantStatus`: `DEPOSITED`, `STAYING`, `LEFT`.
- `ContractStatus`: `PENDING`, `ACTIVE`, `EXPIRED`, `CANCELLED`, `TERMINATED`.
- `ChargeType`: `ROOM_RENT`, `DEPOSIT`, `ELECTRICITY`, `WATER`, `PARKING`, `INTERNET`, `GARBAGE`, `CLEANING`, `DAMAGE_FEE`, `OTHER`.
- `ChargeStatus`: `UNPAID`, `PARTIAL`, `PAID`, `OVERPAID`, `CANCELLED`.
- `PaymentMethod`: `BANK_TRANSFER`, `CASH`, `CREDIT`.
- `CreditLedgerType`: `OVERPAYMENT`, `APPLY_TO_CHARGE`, `REFUND`.
- `CreditLedgerStatus`: `POSTED`, `VOIDED`.
- `TenantCreditActivityType`: `APPLY_TO_CHARGE`, `REFUND`.
- `TenantCreditActivityStatus`: `POSTED`, `VOIDED`.
- `RefundMethod`: `CASH`, `BANK_TRANSFER`.
- `TransactionClassification`: `RENT_MATCHED`, `SUSPICIOUS`, `OTHER`.
- `PaymentMatchStatus`: `AUTO_MATCHED`, `NEEDS_REVIEW`, `IGNORED`.

Model chính:

- `Business`: chủ thể tenant của hệ thống, có `businessSlug` cho public payment portal.
- `User`: người dùng hệ thống, có role và optional `businessId`.
- `AuthSession`: refresh session đã hash token, dùng để rotate/revoke.
- `RoomArea`: khu/dãy/tầng phòng; unique theo `(businessId, name)`.
- `Room`: phòng thuộc `RoomArea`; unique theo `(businessId, roomAreaId, roomCode)`.
- `Tenant`: người đại diện hợp đồng, được tạo từ flow hợp đồng.
- `RentalContract`: hợp đồng thuê, đại diện bởi `representativeTenantId`, hỗ trợ nhiều phòng qua `RentalContractRoom`.
- `ContractOccupant`: người ở cùng/occupant của hợp đồng.
- `BillingPeriod`: kỳ tính tiền theo tháng/năm.
- `Charge`: khoản phải thu, có `paymentCode` unique và `transferContent`.
- `ChargeItem`: dòng chi tiết của `Charge`, cascade delete theo `Charge`.
- `Payment`: khoản thanh toán tiền mặt, chuyển khoản hoặc bút toán cấn trừ credit (`CREDIT`).
- `CreditLedger`: sổ cái tiền dư theo tenant/contract/room/sourceCharge/sourcePayment. Entry `OVERPAYMENT` là số dương; `APPLY_TO_CHARGE` và `REFUND` là số âm; không xóa ledger mà dùng `status=VOIDED` để audit.
- `TenantCreditActivity`: chứng từ/nhật ký nghiệp vụ cho mỗi lần cấn trừ hoặc hoàn tiền credit, có `activityCode`, người tạo, thông tin người nhận hoàn tiền, tài khoản ngân hàng chủ trọ dùng để hoàn và trạng thái đối soát giao dịch ra.
- `BankAccount`, `BankConnection`, `BankTransaction`, `PaymentMatch`: tài khoản ngân hàng, kết nối mock, giao dịch và kết quả match.
- `NotificationLog`: log hành động liên quan gửi/xem/copy/tải QR/public lookup.
- `AuditLog`: audit nghiệp vụ nội bộ.

## 3. Scope dữ liệu, phân quyền, query chung

- Hầu hết dữ liệu nghiệp vụ được scope bằng `businessId` lấy từ JWT user.
- Helper `requireBusinessId(user, requestedBusinessId?)`:
  - `SUPER_ADMIN` phải truyền `businessId` khi tạo dữ liệu scoped.
  - user business phải có `user.businessId`.
- Helper `scopedWhere/scopedData` tự gắn `businessId` cho user không phải `SUPER_ADMIN`.
- `BaseCrudService.listItems` trả chuẩn:

```json
{
  "items": [],
  "meta": { "page": 1, "take": 20, "total": 0, "pages": 0 }
}
```

- Query list chung: `page`, `limit` (1-100), `search`, `sortBy`, `sortOrder=asc|desc`, cộng các filter riêng từng route.

## 4. Luồng logic đã làm được

### 4.1 Auth/session

1. `POST /api/auth/login` nhận phone/password.
2. Kiểm tra user active, bcrypt password.
3. Tạo `AuthSession`, hash refresh token, mirror Redis key `auth:session:{sessionId}` và set `auth:user_sessions:{userId}`.
4. Set cookie `accessToken` và `refreshToken`, ghi audit `LOGIN`.
5. `POST /api/auth/refresh` verify refresh cookie, so hash token, rotate refresh token. Nếu phát hiện token reuse thì revoke toàn bộ session của user.
6. Logout/revoke set `revokedAt`, xóa mirror Redis, clear cookie.

### 4.2 Phòng/khu phòng

- Tạo `RoomArea`, sau đó tạo `Room` thuộc khu.
- `roomCode` được normalize uppercase, thay khoảng trắng/gạch bằng `-`, và tự prefix theo tên khu nếu chưa có. Ví dụ khu `A`, phòng `101` thành `A-101`.
- Đổi tên `RoomArea` sẽ tính lại `roomCode` của các phòng trong khu, có kiểm tra trùng trước khi update transaction.
- Phòng có hợp đồng `PENDING/ACTIVE` hoặc status `DEPOSITED/OCCUPIED` không được xóa/chuyển status thủ công sang maintenance/inactive.
- Status `OCCUPIED` và `DEPOSITED` chỉ được set bởi flow hợp đồng, không set trực tiếp qua Room API.

### 4.3 Hợp đồng, khách thuê, người ở

- `POST /api/contracts` là flow tạo khách thuê đại diện + hợp đồng + link phòng + occupants + charge tiền cọc nếu có.
- `Tenant` không được tạo trực tiếp từ `POST /api/tenants`; controller trả lỗi "Tenants must be created from rental contracts".
- Contract có thể gắn nhiều phòng qua `roomIds`, phòng đầu là `roomId` đại diện.
- Nếu contract `ACTIVE` và `startDate` đã tới ngày hiệu lực: phòng thành `OCCUPIED`, tenant/occupants thành `STAYING`, tính `currentOccupantCount`.
- Nếu `PENDING` hoặc `ACTIVE` nhưng `startDate` trong tương lai: phòng thành `DEPOSITED`, occupant count = 0, tenant/occupants `DEPOSITED`.
- List/get contract và tenant có sync trạng thái theo ngày hiện tại trước khi trả dữ liệu.
- Đóng hợp đồng (`terminate/expire/cancel`) set room còn trống thành `AVAILABLE`, occupants `LEFT`, representative tenant `LEFT` nếu không còn contract active khác.
- Transfer room chỉ áp dụng với contract `ACTIVE`, tạo contract mới ở phòng mới, terminate contract cũ, chuyển selected occupants, có audit metadata.

### 4.4 Kỳ tính tiền và khoản thu

- `BillingPeriod` có thêm `createdBy/creator` để lưu người tạo kỳ.
- `BillingPeriod` tạo theo `month/year`; nếu FE không truyền thì mặc định lấy tháng/năm hiện tại, `startDate` là ngày hiện tại và `endDate` = `startDate + 1 tháng`.
- Khi tạo kỳ thu chỉ chấp nhận trạng thái `OPEN` hoặc `LOCKED`; mặc định là `OPEN`.
- `BillingPeriod` chỉ cho sửa `endDate` khi trạng thái hiện tại là `OPEN` hoặc `LOCKED`.
- Chuyển trạng thái hợp lệ:
  - `OPEN -> LOCKED/CLOSED`
  - `LOCKED -> OPEN/CLOSED`
  - `CLOSED` không được mở lại.
- Kỳ thu tới hoặc qua `endDate` sẽ tự động chuyển `CLOSED`; backend vừa chạy kiểm tra nền mỗi 60 giây, vừa đồng bộ lại khi đọc/ghi kỳ thu.
- `POST /api/billing-periods/:id/generate-monthly-rent` chỉ chạy khi kỳ đang `OPEN`; kỳ `LOCKED` hoặc `CLOSED` sẽ bị chặn. Endpoint tạo charge `ROOM_RENT` cho các contract `ACTIVE` trong kỳ, bỏ qua nếu đã có charge tiền phòng chưa bị cancel.
- Lần đầu tạo tiền phòng có thể trừ số tiền cọc đã thu (`DEPOSIT`) của contract.
- `Charge` luôn có `paymentCode` dạng `RTP-XXXXXX`, `transferContent` dạng `{prefix} {paymentCode}`. Prefix ví dụ: `THUE`, `COC`, `DIEN`, `NUOC`.
- `Charge` có nhiều `ChargeItem`; `amountDue` bằng tổng items.
- Charge tiền phòng bắt buộc liên kết effective active contract và không được trùng theo `(contractId, billingPeriodId)` khi chưa cancel.
- Tạo/update charge yêu cầu bank account active có ít nhất một `BankConnection` status `CONNECTED`.
- QR trả payload JSON gồm bankCode, accountNumber, accountName, amount còn lại, transferContent, paymentCode.

### 4.5 Thanh toán và giao dịch ngân hàng

- Tiền mặt: `POST /api/payments/cash` tạo payment `CASH`, rồi recalculate charge:
  - tổng confirmed = 0 => `UNPAID`
  - nhỏ hơn due => `PARTIAL`
  - bằng due => `PAID`
  - lớn hơn due => `OVERPAID`
- Hủy payment set `PaymentStatus.CANCELLED` và recalculate charge.
- Webhook ngân hàng:
  - tìm bank account theo `bankCode + accountNumber + ACTIVE`.
  - chống duplicate theo `(bankAccountId, transactionRef)`.
  - chỉ xử lý auto-match giao dịch `IN` amount > 0.
  - extract mã thanh toán bằng regex `RTP-[A-Z0-9]{6}` trong description.
  - Match hợp lệ => `RENT_MATCHED/AUTO_MATCHED/confidence=100`, tự tạo payment `BANK_TRANSFER`.
  - Không có mã nhưng description giống nội dung thuê/phòng/điện/nước => `SUSPICIOUS/NEEDS_REVIEW`.
  - Mã không tồn tại hoặc charge đã cancel => suspicious/needs review.
- Khi payment hoặc bank transaction thay đổi: xóa cache dashboard và phát realtime event.

### 4.5.1 Tiền dư, credit, cấn trừ và hoàn tiền

- Payment vẫn là dòng tiền hoặc bút toán đã ghi nhận. `CASH`/`BANK_TRANSFER` là tiền thực nhận; `CREDIT` là bút toán nội bộ khi cấn trừ tiền dư sang khoản thu khác.
- Recalculate charge hiện cap `amountPaid <= amountDue`. Phần tiền nhận vượt `amountDue` được ghi vào `CreditLedger` dạng `OVERPAYMENT` dương, gắn `sourceChargeId` và `sourcePaymentId`.
- `creditBalance` của một charge nguồn là tổng signed ledger `POSTED` theo `sourceChargeId`. `overpaidAmount` là tổng lịch sử `OVERPAYMENT` còn posted. `remainingAmount = max(amountDue - amountPaid, 0)`.
- Charge có payment vượt due và còn credit chưa xử lý sẽ có status `OVERPAID`; nếu credit đã được apply/refund hết thì charge về `PAID`.
- `POST /api/tenant-credits/apply` tạo `TenantCreditActivity` type `APPLY_TO_CHARGE`, tạo `Payment` method `CREDIT` trên target charge, tạo ledger `APPLY_TO_CHARGE` âm trên source charge, tự sinh note mặc định để nhìn rõ khoản cấn trừ đi đâu, rồi recalculate cả source/target.
- `POST /api/tenant-credits/refund` tạo `TenantCreditActivity` type `REFUND` và ledger `REFUND` âm. Mọi refund đều phải có người nhận, nội dung và thời điểm hoàn; riêng `BANK_TRANSFER` còn bắt buộc chọn `ownerBankAccountId` (tài khoản chủ trọ dùng để chuyển), ngân hàng người nhận và số tài khoản người nhận.
- Webhook giao dịch `OUT` không tạo payment, nhưng sẽ thử link vào activity refund bank transfer nếu amount khớp, description chứa `transferContent` và đúng tài khoản chủ trọ đã chọn; khi khớp sẽ cập nhật cả `TenantCreditActivity.bankTransactionId/bankMatchedAt` và các `CreditLedger` liên quan. Khi tạo refund bank transfer cũng thử tìm giao dịch OUT tương ứng để link ngay trên đúng tài khoản đó.
- Không cho hủy payment nguồn nếu overpayment từ payment đó đã được cấn trừ hoặc hoàn tiền; message trả rõ để tránh âm ledger.

### 4.6 Public payment portal

- Public route theo slug doanh nghiệp: `/api/public/pay/:businessSlug`.
- `GET /api/public/pay/:businessSlug` trả `businessName`, `businessSlug` nếu business active.
- `POST /api/public/pay/:businessSlug/lookup` nhận `roomCode`, `representativePhone`, tìm contract active của phòng và đại diện.
- Lookup trả `portalAccessToken` JWT 30 phút và danh sách charge của contract, kèm `remainingAmount`, `isOverdue`.
- Token public được cache Redis key `portal:{tokenId}` TTL 1800s, nhưng verify hiện vẫn chấp nhận payload JWT nếu cache miss.
- `GET /api/public/pay/:businessSlug/charges/:chargeId/qr` cần header `X-Portal-Access-Token`.

## 5. API theo nhóm

Tất cả endpoint bên dưới có prefix `/api`.

### 5.1 Auth

- `POST /auth/login` public, rate-limit 10/phút/IP.
  - Body: `{ "phone": "0xxxxxxxxx hoặc +84...", "password": ">=6 ký tự" }`
  - Response: user profile từ `me`, đồng thời set cookie.
- `POST /auth/refresh` public, rate-limit 30/phút/IP.
  - Dùng cookie `refreshToken`, response user profile và rotate cookie.
- `POST /auth/logout`: logout session hiện tại.
- `POST /auth/logout-all`: revoke mọi session của user.
- `GET /auth/me`: thông tin user hiện tại + business.
- `GET /auth/sessions`: danh sách session của user.
- `POST /auth/sessions/revoke`
  - Body: `{ "sessionId": "..." }`

### 5.2 Businesses và users

- `GET /businesses` (`SUPER_ADMIN`): list business. Filter `status`, search `businessName/businessSlug/ownerName/taxCode`.
- `POST /business-owners` (`SUPER_ADMIN`):
  - Body chính: `businessName`, `businessSlug`, `ownerName`, `taxCode?`, `address?`, `fullName?`, `phone`, `password?`.
  - Tạo Business + User role `BUSINESS_OWNER` trong transaction.
- `GET /business`: business của user hiện tại.
- `PATCH /business`: update business hiện tại.
- `GET /users` (`SUPER_ADMIN`, `BUSINESS_OWNER`): list user. Filter `role`, `isActive`, `businessId`.
- `POST /users`: tạo user. BUSINESS_OWNER chỉ tạo được STAFF.
- `PATCH /users/:id`: update user; nếu có `password` thì hash lại, không cho đổi `businessId` qua endpoint này.
- `GET /staff`, `POST /staff`: alias cho BUSINESS_OWNER thao tác staff.

### 5.3 Room areas và rooms

- `GET /room-areas`: list khu phòng, include `_count.rooms`.
- `GET /room-areas/:id`: chi tiết khu.
- `POST /room-areas`
  - Body: `{ "name": "...", "description": "..." }`
- `PATCH /room-areas/:id`: đổi tên/mô tả, tự sync roomCode nếu đổi tên.
- `DELETE /room-areas/:id`: chỉ xóa khi chưa có phòng.
- `GET /rooms`: list phòng.
  - Query: `status`, `roomAreaId`, `search`, `availableForContract=true`, sort `roomCode/baseRentAmount/area/status/currentOccupantCount/createdAt`.
  - Response item include `roomArea`, và list thường có thêm `currentTenants`.
- `GET /rooms/check-code?roomCode=&roomAreaId=&exceptId=`: kiểm tra roomCode sau normalize có trùng không.
- `GET /rooms/:id`: chi tiết phòng.
- `POST /rooms`
  - Body chính: `roomAreaId`, `roomCode`, `area?`, `baseRentAmount`, `maxOccupants?`, `status?`, `note?`.
  - Nếu trùng phòng khi create có thể trả object duplicate kèm `alreadyExists: true`.
- `PATCH /rooms/:id`: update phòng.
- `PATCH /rooms/:id/status`
  - Body: `{ "status": "AVAILABLE|MAINTENANCE|INACTIVE" }`; không set trực tiếp `DEPOSITED/OCCUPIED`.
- `DELETE /rooms/:id`: chỉ khi không reserved/occupied và không có contract pending/active.

### 5.4 Tenants và contracts

- `GET /tenants`: list tenant. Filter `status`, search `fullName/phone/identityNumber/permanentAddress`. Item có `roommateCount`, `currentRooms`.
- `GET /tenants/:id`: chi tiết tenant, thêm `roommateCount`, `currentRooms`, `roommates`.
- `POST /tenants`: hiện bị chặn, tenant phải tạo qua contract.
- `PATCH /tenants/:id`: update thông tin tenant.
- `PATCH /tenants/:id/left`: set tenant `LEFT`.
- `GET /contracts`: list hợp đồng. Filter `status`, `roomId`, `representativeTenantId`.
- `GET /contracts/:id`: chi tiết include room/roomArea/contractRooms/representativeTenant/occupants.
- `POST /contracts`
  - Body chính:

```json
{
  "roomIds": ["roomId1", "roomId2"],
  "startDate": "2026-05-22",
  "endDate": "2026-08-22",
  "rentAmount": 3000000,
  "depositAmount": 1000000,
  "paymentCycle": "MONTHLY",
  "paymentDueDay": 5,
  "status": "ACTIVE",
  "tenant": {
    "fullName": "Nguyen Van A",
    "phone": "0912345678",
    "identityNumber": "012345678901",
    "permanentAddress": "..."
  },
  "occupants": [
    {
      "fullName": "Nguyen Van B",
      "phone": "0987654321",
      "identityNumber": "012345678902",
      "occupantType": "ADULT",
      "relationship": "roommate",
      "roomId": "roomId1"
    }
  ]
}
```

- `PATCH /contracts/:id`: bị chặn, không edit trực tiếp contract.
- `PATCH /contracts/:id/activate`: chuyển contract sang active.
- `PATCH /contracts/:id/terminate`, `/expire`, `/cancel`: đóng contract.
- `POST /contracts/:id/transfer-room`
  - Body: `newRoomId`, `transferDate?`, `representativeTenantId?`, `occupantIds?`, `rentAmount?`, `depositAmount?`, `paymentCycle?`, `paymentDueDay?`, `note?`.
  - Response: `{ success, message, data: { oldContract, newContract, oldRoom, newRoom } }`.

### 5.5 Billing periods, charges, payments

- `GET /billing-periods`: list kỳ. Filter `status`, `year`.
- `POST /billing-periods`
  - Body: `month`, `year`, `startDate?`, `endDate?`, `status?`.
  - Response include thêm `creator`.
- `GET /billing-periods/:id`
  - Detail kỳ thu, include thêm `creator`.
- `PATCH /billing-periods/:id`
  - Body: `{ "endDate": "ISO date" }`.
  - Chỉ cho kỳ `OPEN` hoặc `LOCKED`.
- `PATCH /billing-periods/:id/status`
  - Body: `{ "status": "OPEN|CLOSED|LOCKED" }`.
- `POST /billing-periods/:id/generate-monthly-rent`
  - Response: `{ "createdCount": number, "items": Charge[] }`.
- `GET /charges`: list khoản thu.
  - Query: `search`, `chargeType`, `status`, `billingPeriodId`, `roomId`, `billingMonth`, `billingYear`, `isOverdue=true|false`.
  - Include: room/roomArea, payerTenant, billingPeriod, bankAccount, items, và field tính toán `overpaidAmount`, `creditBalance`, `remainingAmount`.
- `GET /charges/context?roomId=&billingPeriodId=`
  - Response: `room`, active `contract`, current `tenants`, `openPeriods`, `connectedBankAccounts`, `defaultBankAccount`, `hasRoomRentCharge`.
- `GET /charges/:id`: chi tiết charge include payments/items/sourceCreditLedgers/targetCreditLedgers và field tính toán credit.
- `GET /charges/:id/qr`: rate-limit 60/phút/business-or-IP.
- `POST /charges`
  - Body chính: `roomId`, `contractId?`, `payerTenantId?`, `billingPeriodId?`, `bankAccountId`, `title?`, `dueDate?`, `paymentLink?`, `items`.
  - `items`: `[{ "chargeType": "ELECTRICITY", "title": "Tiền điện", "amount": 100000, "note": "..." }]`.
- `PATCH /charges/:id`: chỉ update khi status `UNPAID` hoặc `PARTIAL`; không cho đổi `paymentCode/transferContent`.
- `PATCH /charges/:id/cancel`: chỉ khi chưa settled (`PAID/OVERPAID`).
- `GET /payments`: list payment. Filter `method`, `status`, `collectedBy`.
- `POST /payments/cash`
  - Body: `{ "chargeId": "...", "amount": 100000, "paidAt": "2026-05-22T00:00:00.000Z", "note": "..." }`
  - Response: `{ payment, charge }`.
- `PATCH /payments/:id/cancel`: hủy payment và recalculate charge.

### 5.5.1 Tenant credits

- `GET /tenant-credits`: list ledger credit.
  - Query: `tenantId`, `contractId`, `roomId`, `sourceChargeId`, `status`, `type`, `page`, `limit`, `sortBy`, `sortOrder`.
  - Include: `sourceCharge`, `targetCharge`, `sourcePayment`, `targetPayment`, `bankTransaction`.
- `GET /tenant-credits/summary`: tổng credit theo filter.
  - Query: `tenantId`, `contractId`, `roomId`, `sourceChargeId`.
  - Response: `{ creditBalance, overpaidAmount, appliedAmount, refundedAmount }`.
- `POST /tenant-credits/apply`
  - Body: `{ "sourceChargeId": "...", "targetChargeId": "...", "amount": 100000, "note": "..." }`; `amount` optional, mặc định lấy min(creditBalance, target remaining).
  - Tạo payment `CREDIT` trên target charge và ledger `APPLY_TO_CHARGE` âm trên source charge.
- `POST /tenant-credits/refund`
  - Body CASH: `{ "sourceChargeId": "...", "amount": 100000, "refundMethod": "CASH", "recipientAccountName": "Nguyễn Văn A", "transferContent": "Hoàn tiền dư tháng 5", "transferredAt": "2026-05-24T10:30:00+07:00", "note": "..." }`.
  - Body BANK_TRANSFER: thêm `ownerBankAccountId`, `recipientBankName`, `recipientAccountNumber`; response trả `activity`, `ledgers`, `sourceCharge`, `bankTransaction`.
  - Body BANK_TRANSFER yêu cầu thêm `recipientBankName`, `recipientAccountNumber`, `recipientAccountName`, `transferContent`, `transferredAt`.
  - Tạo activity + ledger `REFUND` âm và tự link `bankTransactionId` nếu tìm được giao dịch OUT khớp.
- `GET /tenant-credit-activities`: list hoạt động xử lý credit.
  - Query: `type`, `sourceChargeId`, `tenantId`, `contractId`, `roomId`, `refundMethod`, `status`, `bankMatched=true|false`, `bankMatchedState=BANK_MATCHED|BANK_UNMATCHED|BANK_NOT_REQUIRED`, `fromDate/toDate`, `createdAtFrom/createdAtTo`, `search`, `page`, `limit`, `sortBy`, `sortOrder`.
  - Include: source/target charge, tenant, contract, room/roomArea, creator, bank transaction, ledgers.
- `GET /tenant-credit-activities/:id`: chi tiết activity kèm các ledger allocation.

### 5.6 Ngân hàng và webhook

- `GET /bank-accounts`: list tài khoản. Filter `status`, `isDefault`, `bankCode`.
- `POST /bank-accounts`
  - Body: `bankName`, `bankCode`, `accountNumber`, `accountName`, `isDefault?`, `status?`.
  - Nếu `isDefault=true`, tự unset default account khác trong business.
- `PATCH /bank-accounts/:id`: update account.
- `PATCH /bank-accounts/:id/default`: set account làm default.
- `GET /bank-connections`: list kết nối, include bankAccount.
- `POST /bank-connections/connect-mock`
  - Body: `{ "bankAccountId": "...", "bankCode": "...", "provider": "MANUAL" }`.
- `PATCH /bank-connections/:id/disconnect`: set `DISCONNECTED`.
- `GET /bank-transactions`: list giao dịch. Filter `classification`, `type`, `bankAccountId`.
- `GET /payment-matches`: list kết quả match. Filter `matchStatus`.
- `POST /webhook-demo`: webhook test cho user đăng nhập.
- `POST /bank-webhook/demo`: public webhook, rate-limit 60/phút/IP.
  - Body chính: `bankCode`, `accountNumber`, `transactionRef`, `amount`, `description`, `transactionTime?`, `type?`.

### 5.7 Dashboard, reports, logs, public portal

- `GET /dashboard/summary`
  - Query range: `fromDate/toDate`, hoặc `periodType=year|quarter|month`, `year`, `quarter`, `month`.
  - Response gồm tổng phòng, phòng occupied/deposited/available/maintenance, current occupants, active contracts, totalDue/Collected/Debt, cash/bank collected, creditApplied, creditBalance, overpaidAmount, suspicious/other transactions, overdue, recentTransactions, debtByRoom.
- `GET /reports/collection-summary`: tổng charge/payment theo method, thêm `totalCollected`, `creditBalance`, `overpaidAmount`.
- `GET /reports/debt`: charge còn nợ, có `remainingAmount`, `creditBalance`, `overpaidAmount`.
- `GET /reports/payments`: danh sách payment.
- `GET /reports/bank-transactions`: danh sách bank transaction.
- `GET /reports/export-excel`: tải `rentpay-report.xlsx`, rate-limit 10/phút.
- `GET /audit-logs`: list audit. Filter `action`, `entity`, `userId`. SUPER_ADMIN xem cross-business, business user bị scope.
- `GET /audit-logs/payments`: audit entity Payment.
- `GET /notification-logs`: list notification. Filter `action`, `createdBy`.
- `GET /public/pay/:businessSlug`: public business info.
- `POST /public/pay/:businessSlug/lookup`
  - Body: `{ "roomCode": "A-101", "representativePhone": "0912345678" }`
  - Response có `portalAccessToken`, business, room, charges kèm `remainingAmount`, `creditBalance`, `overpaidAmount`.
- `GET /public/pay/:businessSlug/charges/:chargeId/qr`
  - Header: `X-Portal-Access-Token: <portalAccessToken>`.

## 6. Quy tắc nghiệp vụ đáng chú ý

- Phone auth DTO chấp nhận `(0|\+84)[0-9]{9,10}`, nhưng nhiều service nghiệp vụ yêu cầu phone Việt Nam dạng `0` + 9 chữ số (`/^0\d{9}$/`).
- CCCD/identityNumber yêu cầu đúng 12 chữ số.
- Tenant đại diện phải có `fullName`, `phone`, `identityNumber`, `permanentAddress`.
- Tenant `dateOfBirth` nếu có phải đủ 18 tuổi theo năm.
- Contract `startDate` không được trước ngày hiện tại; `endDate` nếu có phải sau `startDate` ít nhất 1 tháng.
- `paymentDueDay` trong khoảng 1-31.
- Tổng người trong contract tối đa 10 gồm representative; mỗi phòng không vượt `maxOccupants` (mặc định 10).
- Occupants nếu có người `ADULT` thì phải có ít nhất một adult occupant có phone.
- Phòng `MAINTENANCE/INACTIVE` không được nhận contract active/pending.
- Mỗi phòng không được có contract `PENDING/ACTIVE` khác chồng lên.
- Charge đã `PAID/OVERPAID` không được cancel, charge đã settled/cancelled không được QR/public QR.
- Bank transfer auto-payment chỉ tạo khi match charge hợp lệ và charge chưa `PAID/OVERPAID/CANCELLED`.
- Dashboard cache key `dashboard:{businessId}:{range}` TTL 45s, bị xóa khi thay đổi room/contract/charge/payment/billing/webhook.

## 7. Migration và runtime schema guard

Migration hiện có:

- `20260517235334_init`
- `20260518120000_add_tenant_deposited_and_roommates`
- `20260519093000_add_tenant_roommate_type`
- `20260519094500_drop_tenant_type_column`
- `20260519103000_contract_transfer_statuses`
- `20260519113000_tenant_contract_occupants_prompt_alignment`
- `20260519123000_contract_rooms_and_contract_created_tenants`
- `20260519133000_add_deposited_occupant_status`
- `20260519133100_set_deposited_occupant_default`
- `20260520100000_sync_reserved_room_status`
- `20260520113000_sync_current_contract_occupants`
- `20260520120000_sync_effective_contracts_by_date`
- `20260520133000_add_deposited_room_status_and_deposit_flow`
- `20260520133100_sync_deposited_room_status`
- `20260521110000_add_charge_items`
- `20260521143000_add_room_areas`
- `20260522060000_add_tenant_credit_ledger`
- `20260522073000_add_tenant_credit_activities`

Ngoài migration, `PrismaService.onModuleInit()` còn có runtime schema guard:

- `ensureChargeItemsTable()`: tạo bảng `ChargeItem` nếu thiếu, backfill mỗi `Charge` thành một `ChargeItem`, tạo index và foreign key nếu chưa có.
- `ensureRoomAreasSchema()`: tạo bảng `RoomArea`, thêm `Room.roomAreaId`, backfill khu phòng từ `Room.floor` hoặc prefix `roomCode`, drop unique cũ `Room_businessId_roomCode_key`, sync roomCode theo khu, tạo unique mới `(businessId, roomAreaId, roomCode)`, set `roomAreaId` not null, drop cột cũ `Room.name`, `Room.floor`.
- `ensureTenantCreditLedgerSchema()`: thêm enum/payment method credit nếu thiếu, tạo bảng `CreditLedger`, `TenantCreditActivity`, foreign key và index phục vụ tiền dư/cấn trừ/hoàn tiền khi môi trường chưa chạy migration; backfill activity cho ledger apply/refund cũ.

Điểm cần lưu ý: runtime guard dùng raw SQL và chạy mỗi lần app init. Khi đổi schema liên quan `ChargeItem`, `RoomArea`, `Room.roomAreaId`, `CreditLedger`, `TenantCreditActivity`, cần cập nhật cả migration lẫn guard hoặc cân nhắc bỏ guard sau khi database production đã đồng nhất.

## 8. Cách chạy, build, test

Yêu cầu:

- Node.js 20+
- PostgreSQL
- Redis

Biến môi trường chính trong `.env.example`:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/rentpay_manager"
REDIS_URL="redis://localhost:6379"
PORT=5000
JWT_ACCESS_SECRET=replace_me_access_secret
JWT_REFRESH_SECRET=replace_me_refresh_secret
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
CLIENT_URL=http://localhost:5173
COOKIE_SECURE=false
```

Lệnh local:

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run start:dev
```

Build/chạy production:

```bash
npm run build
npm run start:prod
```

Test/lint/format:

```bash
npm test
npm run lint
npm run format
```

Docker:

```bash
docker compose up --build
```

API mặc định chạy tại `http://localhost:5000/api`. Docker compose kèm service `postgres:16-alpine` và `redis:7-alpine`.

## 9. Checklist khi cập nhật tài liệu này

- Khi thêm route/controller: cập nhật mục API theo nhóm, payload/query/response quan trọng.
- Khi đổi logic nghiệp vụ: cập nhật mục luồng logic và quy tắc nghiệp vụ.
- Khi đổi Prisma schema/migration/runtime guard: cập nhật mục domain/model và migration/schema guard.
- Khi đổi env/script/Docker: cập nhật mục cách chạy/build/test.
- Khi thêm realtime event hoặc cache key mới: cập nhật kiến trúc và flow liên quan.
- Khi thêm/sửa enum hoặc message lỗi/exception trả về API: cần đồng bộ mapping tiếng Việt phía FE trong `FE/src/shared/utils/labels.ts` và `FE/src/shared/utils/messages.ts`.
