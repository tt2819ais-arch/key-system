// Шим: дашборд Deno по умолчанию ищет main.ts — отдаём ему наш main.js,
// чтобы работало при любом entrypoint (main.ts или main.js).
export { default } from "./main.js";
