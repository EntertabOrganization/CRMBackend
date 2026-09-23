import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('CRM Core + Pipelines contract coverage audit', () => {
  it('maps every placeholder contract scenario to executable coverage evidence', () => {
    const coverage = readFileSync(join(process.cwd(), 'CRM_Core_Pipelines', 'CONTRACT_COVERAGE.md'), 'utf8');
    const contractFiles = filesUnder(join(process.cwd(), 'CRM_Core_Pipelines', 'Testing'))
      .filter((path) => path.endsWith('.spec.ts') || path.endsWith('.e2e-spec.ts'));
    const scenarios = contractFiles.flatMap((path) => {
      const contents = readFileSync(path, 'utf8');
      return Array.from(contents.matchAll(/contract\('([^']+)'\)/g)).map((match) => match[1]);
    });

    expect(scenarios.length).toBeGreaterThan(0);
    for (const scenario of scenarios) {
      expect(coverage).toContain(`\`${scenario}\``);
    }
    expect(coverage).not.toMatch(/\|\s+.*\|\s+(TODO|PARTIAL)\s+\|/);
  });
});
