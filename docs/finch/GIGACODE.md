# GigaCode CLI в Finch

Что известно о GigaCode CLI (по коду shmoker-ai, проверенному в закрытом
контуре) и как Finch с ним работает. Если в контуре что-то окажется иначе,
поправьте этот файл: здесь собраны предположения, которые нужно проверить.

## Что такое GigaCode CLI

- **Форк Qwen Code CLI**: те же флаги и устройство конфигов, отличается имя
  бинаря (`gigacode`). Локально его можно подменить на `qwen`.
- Бинарь: `~/.gigacode/bin/gigacode` (или `gigacode-cli`, `gcli`), либо в `PATH`.
- Каталог конфигурации: `~/.gigacode/`, по аналогии с `~/.qwen/`.
- Токен и модели: `~/.gigacode/gigacode_token.json`:
  ```json
  {"token": "...", "expiryDate": 1700000000,
   "config": {"agent": {"models": []},
              "chat":  {"models": [{"model": "...", "description": "...", "url": ".../chat/completions"}]}}}
  ```
  `url` указывает полный endpoint (OpenAI-совместимый шлюз). Токен живёт около
  10 минут; CLI сам перевыпускает его из личных сертификатов пользователя
  (`refresh_token.py`, `device_id`), и сертификаты не покидают машину.
- API: OpenAI-совместимый (`/models`, `/chat/completions`). Есть вариант с
  mTLS (client cert + key в PEM) — «GigaCode IFT SSL».
- Неинтерактивный запуск: `gigacode -p "<prompt>" --approval-mode yolo`.
  Переменные `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`,
  `QWEN_CODE_SUPPRESS_YOLO_WARNING=1`.
- Проектные настройки: `<repo>/.gigacode/settings.json` (`mcpServers`,
  `model.skipNextSpeakerCheck`).
- Логи сессий: `~/.gigacode/projects/<cwd, где "/" заменены на "-">/chats/<uuid>.jsonl`.

## Что уже сделано в Finch

- Программа `gigacode` в таблице программ (`defaults/programs.json`): иконка,
  запуск из меню «новый агент», распознавание процессов `gigacode`,
  `gigacode-cli`, `gcli`. В меню агентов GigaCode стоит первым.
- Закрытая редакция (`FINCH_EDITION=closed`) использует
  `defaults/programs.closed.json`: GigaCode — единственный агент, остальные
  (Claude, Codex, Gemini, …) убраны; шеллы, редакторы и утилиты остались.

## Что предстоит (см. ROADMAP.md)

1. **Статус агента** (Working / Blocked / Idle) для GigaCode. Finch получает
   статус по протоколу OSC 7501, а Qwen Code его не отправляет. Зато Qwen при
   `ui.showStatusInTitle: true` пишет статус в заголовок окна: `✳ …` = ждёт
   пользователя, `◐ …` = работает. План: в ядре переводить заголовок в статус
   для программ без 7501 (правила для Qwen Code,
   включая русскую строку «Ожидание подтверждения от пользователя...»).
2. **Выбор модели** при запуске: читать `config.chat.models` и запускать
   `gigacode -m <model>`.
3. **Индикатор токена**: срок из `expiryDate`, предупреждение, если токен
   протух (CLI не обновил его).
4. **MCP-серверы**: редактор `mcpServers` в `.gigacode/settings.json`.

## Что проверить в контуре

- [ ] Бинарь называется `gigacode`? Если иначе, добавьте его в `programs.json`
      (`run` и `match`) в `~/.config/finch/programs.json`, без пересборки.
- [ ] Работает ли `ui.showStatusInTitle` в GigaCode (Qwen-настройка).
- [ ] Флаг выбора модели `-m/--model` в GigaCode.
- [ ] Linux: есть ли Vulkan-драйвер (приложению он нужен) и графическая сессия.
