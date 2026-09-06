.PHONY: up down logs build health backup

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f brain

build:
	docker compose build brain

health:
	curl http://127.0.0.1:$${PORT:-3338}/health

backup:
	./scripts/backup.sh
