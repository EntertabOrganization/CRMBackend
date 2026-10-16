import { verifyContractCase } from '../_harness/adapter';

// Source spec: 29-AI-CoPilot/08-external-mcp-and-oauth.md. These are fail-closed executable contracts, not mocks.
describe('External AI clients, OAuth and MCP tool exposure [repository contracts]', () => {
  it('AC01: Revoked MCP grant fails without executing tool.', async () => {
    await verifyContractCase('29-AI-CoPilot/08-external-mcp-and-oauth::AC01', 'Revoked MCP grant fails without executing tool.', 'INTEGRATION');
  });
  it('AC02: Tool inventory filtered by user rights.', async () => {
    await verifyContractCase('29-AI-CoPilot/08-external-mcp-and-oauth::AC02', 'Tool inventory filtered by user rights.', 'INTEGRATION');
  });
  it('AC03: External client cannot switch to another tenant through crafted arguments.', async () => {
    await verifyContractCase('29-AI-CoPilot/08-external-mcp-and-oauth::AC03', 'External client cannot switch to another tenant through crafted arguments.', 'INTEGRATION');
  });
  it('AC04: High-risk action still waits for exact-args approval.', async () => {
    await verifyContractCase('29-AI-CoPilot/08-external-mcp-and-oauth::AC04', 'High-risk action still waits for exact-args approval.', 'INTEGRATION');
  });
  it('AC05: Expired grant fails even if cache stale.', async () => {
    await verifyContractCase('29-AI-CoPilot/08-external-mcp-and-oauth::AC05', 'Expired grant fails even if cache stale.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('29-AI-CoPilot/08-external-mcp-and-oauth::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('29-AI-CoPilot/08-external-mcp-and-oauth::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('29-AI-CoPilot/08-external-mcp-and-oauth::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('29-AI-CoPilot/08-external-mcp-and-oauth::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
