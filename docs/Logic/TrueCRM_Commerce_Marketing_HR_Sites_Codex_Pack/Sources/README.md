# Source coverage and evidence

| Source | Use | Authority |
|---|---|---|
| `TrueCRM - Business Requirements Document (BRD)` (attached Word) | Four-module business scope and cross-module principles (sections 24–27), broader platform ownership | Approved source |
| `TrueCRM - Product Requirements Document (PRD)` (attached Word) | Four module functional requirements (24–27), validation and acceptance; shared cross-module dependencies | Approved source |
| `TrueCRM - System Architecture Document - Complete` (attached Word) | Modular-monolith stack; entities/components/event boundaries for 24–27; other domains ownership | Approved source |
| `TrueAgent_Auth_Module_Codex_Pack(1).zip` (attached) | Agent.md-first pattern, per-domain Markdown, README/manifest and fail-closed Testing contracts | Structural example ONLY |
| `SKILL.md` (attached) | Design-tree interview method; six rounds performed | Interview process |
| `Bitrix-Documentation.txt` (attached) | Links to official `https://apidocs.bitrix24.com/` | Functional reference |
| Approved conversation Q1–Q76 + Shared Understanding Report | Product choices and explicit deviations | Highest current authority |

Official Bitrix24 public references consulted (2026-10-12):
- https://helpdesk.bitrix24.com/open/25809723/ — online store overview, catalog, payments/delivery and CRM
- https://helpdesk.bitrix24.com/open/25826751/ — payment systems and restrictions
- https://helpdesk.bitrix24.com/open/17297482/ — delivery setup
- https://helpdesk.bitrix24.com/open/20166846/ — multichannel marketing campaigns
- https://helpdesk.bitrix24.com/open/21257152/ — static/dynamic audiences
- https://helpdesk.bitrix24.com/open/25743741/ — sites, templates, AI creation
- https://helpdesk.bitrix24.com/open/25558484/ — multi-page sites and shared blocks
- https://helpdesk.bitrix24.com/open/14759098/ — Bitrix site publication behavior
- https://helpdesk.bitrix24.com/open/15433888/ — plan-specific site publication availability
- https://apidocs.bitrix24.com/ — REST API reference hub

The pack does **not** assert that Bitrix24 provides identical internal schemas/APIs or that its workflows are binding where approved TrueCRM decisions differ. This is a newly authored TrueCRM implementation contract, not a copy of Bitrix24 documents.

The original source binaries are **not duplicated** in the ZIP, both to avoid stale copies and because they are already available in the ChatGPT Project. The requirements are incorporated in the specification files and linked through `Decision-Traceability.md`.
