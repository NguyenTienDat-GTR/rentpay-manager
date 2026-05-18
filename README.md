# RentPay Manager Backend

Backend NestJS cho webapp quản lý nhà trọ theo `promt.txt`: PostgreSQL + Prisma, Redis cache/session support, JWT access/refresh token qua httpOnly cookie, QR nội bộ, webhook demo, realtime Socket.IO, dashboard và báo cáo Excel.

## Yêu cầu

- Node.js 20+
- PostgreSQL
- Redis

## Cài đặt

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run seed
npm run start:dev
```

API mặc định chạy tại `http://localhost:5000/api`.

## Chạy bằng Docker

```bash
docker compose up --build
```

Lần đầu tạo database:

```bash
docker compose exec app npx prisma migrate dev --name init
docker compose exec app npm run seed
```

## Tài khoản seed

- SUPER_ADMIN: `0900000000` / `123456`
- BUSINESS_OWNER: `0901000000` / `123456`

## Demo flow backend

1. `POST /api/auth/login` với phone `0901000000`, password `123456`.
2. `GET /api/billing-periods` lấy kỳ `05/2026`.
3. `POST /api/billing-periods/:id/generate-monthly-rent`.
4. `GET /api/charges` xem charge và `paymentCode`.
5. `GET /api/charges/:id/qr` sinh QR động từ charge + bank account, không lưu `qrBase64`.
6. `POST /api/webhook-demo` với mô tả `THUE RTP-xxxxxx` để auto-match.
7. `POST /api/payments/cash` để ghi nhận tiền mặt.

## Public payment portal API

- `GET /api/public/pay/hkd-nha-tro-minh-an`
- `POST /api/public/pay/hkd-nha-tro-minh-an/lookup`

Body:

```json
{
  "roomCode": "P101",
  "representativePhone": "0901000001"
}
```

API trả về `portalAccessToken`; dùng token này ở header `X-Portal-Access-Token` khi gọi:

```http
GET /api/public/pay/hkd-nha-tro-minh-an/charges/:chargeId/qr
```

## Security notes

- Backend đăng nhập bằng số điện thoại, không dùng email.
- Access token và refresh token nằm trong httpOnly cookie.
- Refresh token được hash trước khi lưu ở `AuthSession`.
- Mỗi lần refresh sẽ rotate refresh token.
- Logout/revoke session cập nhật `revokedAt` và xóa mirror session Redis.
- Dữ liệu nghiệp vụ luôn scope bằng `businessId` lấy từ user đăng nhập.

## Redis usage

- Cache dashboard summary: key `dashboard:{businessId}:*`, TTL 45 giây.
- Public portal lookup/rate limit: TTL ngắn.
- Auth session mirror: key `auth:session:{sessionId}`.
- Login/public lookup/webhook demo rate limit.

Nếu Redis chưa chạy, service sẽ log cảnh báo và backend vẫn chạy được cho local dev, nhưng cache/rate-limit/session mirror sẽ bị bỏ qua.
