# Finch: руководство для разработки

Finch — десктопное приложение (Rust, GPUI, Ghostty) для терминалов и coding-агентов.
Ядро `finch-core` (команда `hc`) лежит в `core/`, приложение — в корне.

## Устройство

- `src/` — приложение: окно, раскладки, терминалы, хост для модов.
  - `src/edition.rs` — редакции (`FINCH_EDITION=full|closed`).
  - `src/i18n.rs` + `defaults/locales/*.json` — перевод всего текста модов.
  - `src/tail.rs` — чтение больших растущих файлов кусками (для чата).
- `crates/finch-shell/` — движок модов (QuickJS + GPUI).
- `defaults/` — встроенные моды, раскладки, клавиши, таблица программ, `finch.d.ts`.
  Всё отсюда вшивается в бинарник (`build.rs`) и копируется в `~/.config/finch/`.
- `core/` — ядро: держит терминалы живыми вне окна.
- `vendor/` — патченые копии gpui, taffy, quickjs; правки помечены `FINCH:`.

## Правила

- Пишите тексты модов на английском: перевод делает `defaults/locales/ru.json`.
  Непереведённое показывает `scripts/finch-strings.py --missing`.
- Новые функции хоста для модов регистрируйте в `src/mods.rs`, объявляйте в
  `defaults/finch.d.ts` и добавляйте в тестовую заглушку `src/mods/render_tests.rs`.
- Новая команда окна: `src/commands.rs`, обработчик в `src/window.rs`, упоминание в
  `defaults/AGENTS.md` (тест проверяет, что руководство называет каждую команду).
- Закрытая редакция не должна ходить в сеть и подключать другие машины.
- Никаких самообновлений, телеметрии и отправки отзывов.

## Проверки

```sh
cargo test --locked -p finch -p finch-shell
bun test scripts/*.test.ts
(cd core && cargo test --locked -p finch-core)
scripts/finch-package full        # собрать и упаковать
finch check ~/.config/finch/mods/<мод>   # проверить мод
```

Перед сдачей работы — все тесты зелёные, мод проходит `finch check`, изменение
проверено в запущенном приложении (`finch shot` делает снимок окна).
