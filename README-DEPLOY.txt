================================================================
  DENO DEPLOY — БЕСПЛАТНЫЙ ХОСТИНГ БЕЗ ГОЛОВНОЙ БОЛИ
  Один деплой = панель + API на одном домене, база встроена.
  Карта не нужна, KV/биндинги настраивать НЕ надо — Deno KV
  персистентен из коробки (данные НЕ слетают как в CF без KV).
================================================================

ШАГ 0. Поставь Deno (один раз, Windows PowerShell):
  irm https://deno.land/install.ps1 | iex
  # закрой и открой терминал, проверь: deno --version

ШАГ 1. Поставь deployctl (один раз):
  deno install -gArf jsr:@deno/deployctl

ШАГ 2. Создай проект:
  - зайди на https://dash.deno.com (логин через GitHub, это бесплатно)
  - New Project > назови например cheat-panel
  - итог: https://cheat-panel.deno.net (имя подставь своё)

ШАГ 3. Сгенерируй секреты:
  cd zcode\api
  node ./scripts/gen-secrets.mjs
  # сохрани 3 значения

ШАГ 4. Задеплой из папки zcode\deno:
  cd zcode\deno
  deployctl deploy --prod --project=cheat-panel --entrypoint=main.js
  (или: deno task deploy — имя проекта поправь в deno.json)

ШАГ 5. Переменные окружения (dash.deno.com > проект > Settings):
  JWT_SECRET, CHEAT_API_SECRET, CHEAT_CRYPTO_KEY_B64 (из шага 3),
  ADMIN_EMAIL=admin@cheat.com, ADMIN_PASSWORD=123098, APP_ID=cheat-ios-01
  После добавления секретов сделай redeploy (кнопка в дашборде)
  или снова deployctl.

ШАГ 6. Открой https://cheat-panel.deno.net/home
  Вход: admin@cheat.com / 123098. Сразу смени пароль:
  PATCH /v1/sellers/admin%40cheat.com {"password":"НОВЫЙ"} (авторизуйся как admin).

ЧТО ДАЛЬШЕ:
  - Чит стучится на https://cheat-panel.deno.net/v1/cheat/validate
    (в windows_client.py поменяй API_BASE на этот URL).
  - Windows-тест: set API_BASE=https://cheat-panel.deno.net
    python zcode\key-system\windows_client.py --key "XXXX-..."
  - Локальная проверка без деплоя: cd zcode\deno && deno run -A main.js
    -> http://localhost:8000/home
  - Роутеры /home /keys /create-key /sellers /logs /settings + 404
    работают из коробки (SPA-фолбэк в main.js, _redirects не нужен).
  - Лимиты/stealth-бан/шифрование — те же что в INTEGRATION.txt.
  - Бесплатный тариф Deno Deploy щедрый, слипа нет, карта не нужна.

ПОЧЕМУ НЕ CLOUDFLARE:
  - Дашборд-аплоадер не ест wrangler.toml и многофайловые воркеры.
  - Без KV-биндинга Worker хранит всё в памяти и ТЕРЯЕТ данные
    при рестарте — отсюда "файлы не сохраняются".
  Файлы CF-версии оставлены (zcode/api, zcode/web) — вернутся если захочешь.
================================================================
