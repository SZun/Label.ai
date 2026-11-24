.PHONY: bootstrap build verify test test-e2e package safari-xcode
bootstrap:
	pnpm install --frozen-lockfile
	node ml/provision-model.mjs apps/extension/public/models
	python3 tools/prepare_provenance_fixtures.py
build:
	pnpm run build:chrome
	pnpm run build:safari
test:
	python3 -m unittest discover -s tests/quality -v
	pnpm test
verify: test
	pnpm format:check
	pnpm -r --if-present typecheck
	$(MAKE) build
	python3 tools/audit_packages.py apps/extension/.output/chrome-mv3 apps/extension/.output/safari-mv3
test-e2e:
	python3 tests/e2e/browser_test.py --build apps/extension/.output/chrome-mv3 --install-only
	python3 tests/e2e/browser_test.py --build apps/extension/.output/chrome-mv3
package:
	python3 tools/zip_extension.py apps/extension/.output/chrome-mv3 artifacts/packages/label-ai-chromium.zip
	python3 tools/zip_extension.py apps/extension/.output/safari-mv3 artifacts/packages/label-ai-safari.zip
safari-xcode:
	tools/package_safari.sh apps/extension/.output/safari-mv3 artifacts/safari-xcode
