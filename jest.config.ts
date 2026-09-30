import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests', '<rootDir>/Commercial_Capture_ContactCenter/Testing', '<rootDir>/Data_Integration_Intelligence_Analytics/Testing'],
  testMatch: ['**/*.spec.ts', '**/Commercial_Capture_ContactCenter/Testing/**/*.e2e-spec.ts', '**/Data_Integration_Intelligence_Analytics/Testing/**/*.e2e-spec.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testTimeout: 15_000,
};

export default config;
