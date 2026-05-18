# RentPay Manager Backend

Backend NestJS cho webapp quản lý nhà trọ và đặc biệt là quản lí các khoản thanh toán đầu vào hiệu quả hơn so với cách thủ công: PostgreSQL + Prisma, Redis cache/session support, JWT access/refresh token qua httpOnly cookie, QR nội bộ, webhook demo, realtime Socket.IO, dashboard và báo cáo Excel.

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
```

## Public payment portal API

- `GET /api/public/pay/:businessSlug`
- `POST /api/public/pay/:businessSlug/lookup`

Body:

```json
{
  "roomCode": "<room-code>",
  "representativePhone": "<representative-phone>"
}
```

API trả về `portalAccessToken`; dùng token này ở header `X-Portal-Access-Token` khi gọi:

```http
GET /api/public/pay/:businessSlug/charges/:chargeId/qr
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
