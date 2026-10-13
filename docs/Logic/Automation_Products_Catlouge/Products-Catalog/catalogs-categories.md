# Catalogs & Categories

## Catalog

Suggested fields:

- `id`
- `workspaceId`
- `name`
- `code?` stable machine identifier if the repository uses codes
- `description?`
- `isDefault`
- `isActive`
- `sortOrder?`
- optimistic `version`

A Workspace may contain multiple Catalogs. One active Catalog is designated default.

Setting a new default must atomically clear the previous default.

Do not allow zero default Catalog when Product capability requires one; bootstrap/create one according to module initialization policy.

## Category hierarchy

Suggested fields:

- `id`
- `workspaceId`
- `catalogId`
- `parentId?`
- `name`
- `code/slug?` if needed by Commerce/Sites later
- `description?`
- `sortOrder`
- `isActive`
- optional media binding

Prevent cycles. Parent and child must belong to same Workspace and Catalog.

## Product membership

Use a many-to-many membership table or repository-equivalent model:

- Product may belong to multiple categories;
- one membership is primary;
- all memberships must belong to same Catalog context allowed by the Product;
- if categories are optional, `primary` may be null when there are no memberships;
- if memberships exist, enforce exactly one primary for that Product/Catalog context.

## Reordering

Provide atomic category sibling reorder command or sortable position strategy. Do not individually update hundreds of rows from the frontend without transactional semantics.

## Category deletion

Deletion is blocked when:

- child categories exist;
- Product/Variant memberships exist if Variants can be independently categorized by final model;
- dependent publication/navigation references exist.

Return dependency details sufficient for UI to guide reassignment.

Never cascade delete Products.

Empty unused categories may be hard-deleted if repository policy permits. Used categories may alternatively be deactivated/archived; preserve references/history according to integration needs.

## Move category

Moving within tree validates:

- same Workspace/Catalog;
- no self-parent;
- no descendant cycle;
- permissions;
- optional unique sibling code/name constraints.

## APIs

Recommended:

```text
GET/POST  /api/v1/catalogs
GET/PATCH /api/v1/catalogs/:catalogId
POST      /api/v1/catalogs/:catalogId/set-default

GET/POST  /api/v1/catalogs/:catalogId/categories
GET/PATCH /api/v1/catalogs/:catalogId/categories/:categoryId
DELETE    /api/v1/catalogs/:catalogId/categories/:categoryId
POST      /api/v1/catalogs/:catalogId/categories/reorder
POST      /api/v1/catalogs/:catalogId/categories/:categoryId/move
```

Route naming may be adapted to repository domain prefix conventions without changing semantics.

## Acceptance criteria

- Exactly one default Catalog.
- Category cycles are impossible.
- Product can have several category memberships and one primary.
- Deleting a populated category is blocked with actionable error.
- Cross-Catalog/Workspace parenting is rejected.
