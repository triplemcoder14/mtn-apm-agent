.PHONY: all
all:
	npm install

.PHONY: check
check:
	npm run lint

.PHONY: fmt
fmt:
	npm run lint:fix

.PHONY: test
test:
	npm run test
