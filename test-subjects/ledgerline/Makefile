# ledgerline -- self-contained: everything needed to build, run and test it lives in this directory.
#   make up                 build images and start the healthy baseline            (gateway on :8081)
#   make test               start (if needed) and run the API tests against every service
#   make load               generate traffic (20 concurrent users, 60 s)
#   make scenario SCEN=ll-01-pool-starvation-cycle     start with one production condition applied
#   make down               stop and delete volumes (databases re-seed on next start)
#   make ps | logs SVC=<name> | scenarios
#
# Behind a TLS-intercepting proxy, build with:  make up BUILD_CA_BUNDLE=/path/to/ca.crt
.DEFAULT_GOAL := up
COMPOSE      ?= docker compose -f docker-compose.yml
EXPOSE_FILES  = -f docker-compose.expose.yml
SCEN         ?= ll-00-baseline
RENDERED      = .rendered/docker-compose.yml
BUILD_CA_BUNDLE ?=

# images: plain compose build normally; docker build with a CA secret when BUILD_CA_BUNDLE is set
define build
	@if [ -n "$(BUILD_CA_BUNDLE)" ]; then \
	  for d in services/*/; do n=$$(basename $$d); docker build -q --secret id=ca,src=$(BUILD_CA_BUNDLE) -f $$d/Dockerfile -t ledgerline/$$n:dev . >/dev/null || exit 1; done; \
	else $(1) build; fi
endef

# Render ONE effective compose file (baseline + scenario + test ports). The mapper reads declared dependencies from the file named in
# the container label com.docker.compose.project.config_files; several -f files would be comma-joined there and silently break that.
render:
	@mkdir -p .rendered
	@docker compose -f docker-compose.yml -f scenarios/$(SCEN)/compose.override.yml $(EXPOSE_FILES) config > $(RENDERED)

up: render
	$(call build,docker compose -f $(RENDERED))
	docker compose -f $(RENDERED) up -d --no-build
	@echo "ledgerline up: http://localhost:8081  (scenario: $(SCEN))"

scenario: up

wait:
	@for i in $$(seq 1 90); do docker compose -f $(RENDERED) ps --format '{{.Status}}' | grep -qE 'starting|unhealthy' || break; sleep 2; done; sleep 3

test: up wait
	npm ci --silent
	node --test tests/api.test.mjs

load:
	node loadgen/loadgen.mjs --concurrency 20 --duration 60

ps:
	docker compose -f $(RENDERED) ps

logs:
	docker compose -f $(RENDERED) logs --tail 80 $(SVC)

down:
	-COMPOSE_PROFILES=observability docker compose -f $(RENDERED) down -v --remove-orphans

scenarios:
	@ls scenarios

.PHONY: render up scenario wait test load ps logs down scenarios
