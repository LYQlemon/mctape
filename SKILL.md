---
name: mctape
description: Record supported read-only McDonald's MCP calls, replay local recordings as an offline MCP server, and reproduce tool or protocol failures while developing a Skill.
---

# McTape

Use this project to make an MCP interaction reproducible. Determine the project root from this file; run `bin/mctape.mjs` there with Node.js 22 or newer. No package installation is needed.

- To demonstrate without credentials, run `node bin/mctape.mjs demo`. All included stores, prices, responses and schemas are synthetic.
- To connect an existing Skill to the offline MCP server, run `node bin/mctape.mjs config --tape <cassette.json>`. Import the resulting stdio configuration in the host. Use the cassette's exact arguments, including redacted identifiers.
- To reproduce a fault, select `--scenario coupon-expired`, `rate-limited`, `slow`, `empty-menu` or `missing-price`. The last two use the synthetic fixture's fields; for real recordings, inspect the response and use `--faults <rules.json>`. See `examples/faults.json`.
- To record, use `node bin/mctape.mjs config --mode record --out <new-file.json>`. The MCP host must provide `MCD_MCP_TOKEN` in its environment. Discover actual parameters through `tools/list` or `node bin/mctape.mjs schemas`; do not infer them from the demo schema. Only six supported read-only tools are exposed.
- To inspect coverage, use `node bin/mctape.mjs report --tape <cassette.json>`. Distinguish reproducible tool responses from correctness of the consuming Skill. A tool error does not demonstrate that the host handled it correctly.

Replay consumes each matching entry once and never calls the real service. Different arguments or an exhausted record produce an explicit error. Same-key responses retain their recording order, but the server does not enforce global workflow order.

Treat replay data as historical or synthetic, even when the cassette originated from real calls. Do not use replay quotes to recommend current prices or create orders. Preserve source labels when reporting results. A simulated 429 is a JSON-RPC error with transport metadata, rather than an actual HTTP service response.

Live cassette files are local debugging artifacts. Sensitive keys and known Token values are replaced on save; unstructured text still requires review before sharing. Do not publish `tapes/` as part of a routine validation run. Read `README.md` for supported modes and current protocol limitations; read `MCP_INTEGRATION.md` when preparing real integration evidence or competition materials.
