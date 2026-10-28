.PHONY: up down migrate dev test build smoke e2e clean

up:
	docker compose -f deploy/docker-compose.yml up -d

down:
	docker compose -f deploy/docker-compose.yml down

migrate:
	pnpm db:migrate

build:
	pnpm build

dev:
	pnpm dev

test:
	pnpm test

e2e:
	pnpm test:e2e

smoke:
	pnpm smoke

clean:
	pnpm clean
