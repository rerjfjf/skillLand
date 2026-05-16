#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────
#  SkillLand — запуск одним кликом
#  Просто дважды кликни start.sh (или запусти в терминале)
# ────────────────────────────────────────────────────────────

set -e
cd "$(dirname "$0")"

# ── Цвета ───────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

echo ""
echo -e "${BOLD}${CYAN}  ╔══════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}  ║        SkillLand 🚀          ║${NC}"
echo -e "${BOLD}${CYAN}  ╚══════════════════════════════╝${NC}"
echo ""

# ── Проверка Node.js ─────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js не найден.${NC}"
  echo ""
  echo "  Установи Node.js с сайта: https://nodejs.org"
  echo "  (выбери LTS версию — нажми кнопку Download)"
  echo ""
  # Открыть страницу в браузере
  if [[ "$OSTYPE" == "darwin"* ]]; then
    open "https://nodejs.org"
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "https://nodejs.org" 2>/dev/null || true
  fi
  read -p "  Нажми Enter чтобы закрыть..."
  exit 1
fi

NODE_VER=$(node -v)
echo -e "  ${GREEN}✓${NC} Node.js найден: ${YELLOW}${NODE_VER}${NC}"

# ── Проверка: не занят ли порт ──────────────────────────────
PORT=3000
if lsof -iTCP:${PORT} -sTCP:LISTEN -t &>/dev/null 2>&1 || \
   nc -z 127.0.0.1 ${PORT} &>/dev/null 2>&1; then
  echo ""
  echo -e "  ${YELLOW}⚠ Порт ${PORT} уже занят.${NC}"
  echo "    Возможно, сервер уже запущен."
  echo ""
  echo -e "  Открываю браузер: ${CYAN}http://localhost:${PORT}${NC}"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:${PORT}"
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "http://localhost:${PORT}" 2>/dev/null || true
  fi
  read -p "  Нажми Enter чтобы закрыть..."
  exit 0
fi

# ── Запуск ──────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Запускаю сервер на порту ${PORT}...${NC}"
echo -e "  Адрес: ${CYAN}http://localhost:${PORT}${NC}"
echo -e "  Скрытая панель: ${CYAN}http://localhost:${PORT}/secret-admin-panel-x7k9${NC}"
echo ""
echo -e "  ${YELLOW}Не закрывай это окно пока работаешь с сайтом.${NC}"
echo -e "  Для остановки нажми ${BOLD}Ctrl+C${NC}"
echo ""
echo "  ──────────────────────────────────────────"

# Запуск Node с красивым выводом логов
NODE_NO_WARNINGS=1 node server.js
