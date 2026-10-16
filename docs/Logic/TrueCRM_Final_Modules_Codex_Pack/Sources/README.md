# Source coverage and conflicts

Reviewed basis for content:

- Project-attached `TrueCRM - Product Requirements Document (PRD)` (older attached copy) and its updated connected Google Doc including Module 32 Partner: `https://docs.google.com/document/d/12VegqMjABUvG-Z62XbSm0aCod2_bYzDfex9FVSfoqiU`.
- Project-attached `TrueCRM - Business Requirements Document (BRD)` and its updated connected Google Doc including Module 32 Partner: `https://docs.google.com/document/d/1_wGrnf_8ilpjbDCNjZIUAm6QpK70gIVsPgrJmCAn8Vs`.
- Project-attached `TrueCRM - System Architecture Document - Complete` and updated connected Google Doc including Module 32 Partner: `https://docs.google.com/document/d/1J-Jd7-8ioT96HdIfjjwjc4z_eiH8OG4fga-6kOV_Jkg`.
- Reference `TrueAgent_Auth_Module_Codex_Pack(1).zip`: `Agent.md`, `Partner/partner.md`, testing style; structure only for unrelated Auth content.
- Previous `TrueCRM_Commerce_Marketing_HR_Sites_Codex_Pack.zip`: dependency/API boundary and user-approved Q1–Q76.
- `SKILL.md` interview rounds; Q77–Q126 accepted recommendations; approved final Shared Understanding Report.
- `Bitrix-Documentation.txt` link to https://apidocs.bitrix24.com/ and Bitrix24 Helpdesk knowledge 2.0 references at https://helpdesk.bitrix24.com/open/25973127/ and https://helpdesk.bitrix24.com/open/25971079/ .

## Important resolution

Attached exported documents originally stopped at Module 31; the more recent connected TrueCRM docs included Module 32 Partner. Latest user explicitly directed Partner inclusion; this pack therefore covers Module 32 without pretending it is production-implemented. Partner fine-grained role model and integer basis-point discount representation were settled through Q77 and Q78. No repository code is included/assumed; implementations and tests need real repo access.

## Engineering configuration dependencies

Provider credentials, permitted regions/model pricing, platform plan prices, actual partner commission rate schedules, regulatory retention durations, real SMTP/OAuth/payment permissions and deployment RPO/RTO remain production configuration inputs, not hidden product choices. The implementation must fail closed until required policies/config are supplied.
