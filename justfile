default:
    @just --list

build:
    cargo build --locked

test:
    bun test scripts/*.test.ts
    cargo test --locked -p finch -p finch-shell

test-core:
    cd core && cargo test --locked -p finch-core

docs-generate: build
    bun scripts/docs.ts generate

docs-check: build
    bun test scripts/docs.test.ts
    bun scripts/docs.ts check

# A package for this machine: just package full (or closed)
package edition="full":
    scripts/finch-package {{edition}}

[linux]
install:
    bash scripts/install-linux

[macos]
install:
    bash scripts/install-macos
