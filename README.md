# TRUEFORM Backend

Production-ready Ticket-Centric Workflow Engine built with NestJS and Prisma.

## 🚀 Core Principles

- **Multi-Tenancy**: Hard isolation using Prisma Client Extensions. Every query automatically filters by `company_id`.
- **Ticket-Centric**: Tickets are the central execution unit. Forms define structure, Tickets store runtime state.
- **Dynamic Validation**: Ticket answers are validated against form-level JSONB rules.

## 🛠️ Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Database Migration**:
   ```bash
   npx prisma db push
   ```

3. **Run Application**:
   ```bash
   npm run start:dev
   ```

## 🔐 Multi-Tenancy Usage

Pass the `x-company-id` header in all requests to scope the operation to a specific tenant.

Example:
```http
POST /forms
x-company-id: <uuid>
Content-Type: application/json

{
  "name": "Service Request",
  "sections": [...]
}
```

## 🏗️ Architecture

- `src/common`: Multi-tenancy guards, decorators, and shared logic.
- `src/infrastructure`: Database (Prisma) and Logging.
- `src/modules/tickets`: The Core Engine. Handles validation and ticket creation.
- `src/modules/iam`: Identity and Company management.
- `src/modules/forms`: Dynamic form definition layer.
