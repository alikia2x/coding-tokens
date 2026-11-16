# E2E Test Infra: Coding Tokens

## Test Philosophy

- Opaque-box, requirement-driven. No dependency on implementation design.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial Testing + Real-World Workload Testing.
- Validates token metrics (input, output, reasoning, cache read, cache write), session discovery, transcript parsing, cross-platform path resolution, and live host dogfooding.

## Feature Inventory & Test Matrix

| #   | Feature                                  | Source (Requirement) | Tier 1 (Feature) | Tier 2 (Boundary) | Tier 3 (Pairwise) | Tier 4 (Scenario) |
| --- | ---------------------------------------- | -------------------- | :--------------: | :---------------: | :---------------: | :---------------: |
| 1   | PlatformPathService                      | R3 Cross-Platform    |        5         |         5         |         ✓         |         ✓         |
| 2   | Path Normalization & Windows Safety      | R3 Cross-Platform    |        5         |         5         |         ✓         |         ✓         |
| 3   | Tooling & Checks (`check`, `typecheck`)  | R2 Architecture      |        5         |         5         |         ✓         |         ✓         |
| 4   | Extensible Core Models & Colors          | R2 Architecture      |        5         |         5         |         ✓         |         ✓         |
| 5   | HarnessProvider Plugin Abstraction       | R1, R2               |        5         |         5         |         ✓         |         ✓         |
| 6   | HarnessRegistry Dynamic Registration     | R1, R2               |        5         |         5         |         ✓         |         ✓         |
| 7   | StorageService & SQLite Transactions     | R2 Architecture      |        5         |         5         |         ✓         |         ✓         |
| 8   | PricingService Modernization             | R1, R2               |        5         |         5         |         ✓         |         ✓         |
| 9   | Catalog, Reporting & Transcript Services | R2 Architecture      |        5         |         5         |         ✓         |         ✓         |
| 10  | Refactored Existing Harnesses            | R1, R2               |        5         |         5         |         ✓         |         ✓         |
| 11  | Claude Code Provider                     | R1 Mainstream        |        5         |         5         |         ✓         |         ✓         |
| 12  | Cline Provider                           | R1 Mainstream        |        5         |         5         |         ✓         |         ✓         |
| 13  | Roo Code Provider                        | R1 Mainstream        |        5         |         5         |         ✓         |         ✓         |
| 14  | Continue Provider                        | R1 Mainstream        |        5         |         5         |         ✓         |         ✓         |
| 15  | Cursor Provider                          | R1 Mainstream        |        5         |         5         |         ✓         |         ✓         |
| 16  | GitHub Copilot Provider                  | R1 Mainstream        |        5         |         5         |         ✓         |         ✓         |
| 17  | Aider Provider                           | R1 Mainstream        |        5         |         5         |         ✓         |         ✓         |
| 18  | Windsurf Provider                        | R1 Mainstream        |        5         |         5         |         ✓         |         ✓         |
| 19  | Goose Provider                           | R1 Mainstream        |        5         |         5         |         ✓         |         ✓         |
| 20  | OpenHands Provider                       | R1 Mainstream        |        5         |         5         |         ✓         |         ✓         |
| 21  | CLI Modernization & Dynamic Flags        | R1, R2, R3           |        5         |         5         |         ✓         |         ✓         |
| 22  | Server API Modernization                 | R2 Architecture      |        5         |         5         |         ✓         |         ✓         |
| 23  | Desktop Cross-Platform Support           | R3 Cross-Platform    |        5         |         5         |         ✓         |         ✓         |
| 24  | E2E Suite & Regression Coverage          | Acceptance Criteria  |        5         |         5         |         ✓         |         ✓         |
| 25  | Host Dogfooding Verification             | R4 Dogfooding        |        5         |         5         |         ✓         |         ✓         |
| 26  | Adversarial Hardening (Tier 5)           | Quality & Integrity  |        5         |         5         |         ✓         |         ✓         |

## Test Architecture

- Test runner: `bun test`
- Pass/Fail semantics: Exit code 0, zero failures, zero unhandled rejections
- Test directory layout:
  - `tests/unit/`: Unit tests for platform path resolution, token counters, pricing calculation, and individual provider parsers.
  - `tests/integration/`: Service layer integration, SQLite persistence, catalogue building, and CLI invocation.
  - `tests/fixtures/`: Synthetic cross-platform transcript files, SQLite dumps, and config mock directories for all 15+ harnesses across macOS, Linux, and Windows formats.
  - `tests/dogfood/`: Real host environment scanner verifying live installed sessions in `/Users/alikia/`.

## Real-World Application Scenarios (Tier 4)

| #   | Scenario                                         | Features Exercised              | Complexity |
| --- | ------------------------------------------------ | ------------------------------- | ---------- |
| 1   | Full CLI Scan & Export across All Harnesses      | F1, F5, F6, F7, F8, F9, F11-F21 | High       |
| 2   | Server API Catalog Build & Full-Text Search      | F6, F7, F9, F22                 | High       |
| 3   | Simulated Windows & Linux Session Discovery      | F1, F2, F5, F11-F20             | High       |
| 4   | Live Host Dogfooding on Existing Sessions        | F11, F12, F14, F15, F25         | High       |
| 5   | Cross-Harness Multi-Model Token & Cost Reporting | F4, F6, F8, F9, F21, F22        | High       |

## Coverage Thresholds

- Tier 1: ≥5 isolated happy-path cases per feature (~130 tests)
- Tier 2: ≥5 boundary, corner, and error-handling cases per feature (~130 tests)
- Tier 3: Pairwise combinations across major harnesses, OS platforms, and token formats (≥26 tests)
- Tier 4: Real-world application scenarios (≥5 scenarios)
- Total E2E Target: ≥290 automated test cases
