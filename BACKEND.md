# Backend: BCCR, préstamos y deudas

## 1. Supabase

Ejecuta `supabase/schema.sql` en el editor SQL del proyecto. La tabla `bccr_rates` guarda una observación cuando el valor de un indicador cambia; la tabla `bccr_rate_status` registra cada consulta y conserva la última sincronización exitosa. Los registros públicos son únicamente indicadores financieros del BCCR. Los resúmenes de usuarios no se envían ni se guardan en Supabase.

El esquema actual migra la tabla `bccr_rates` creada por el prototipo para admitir valores de tipo de cambio por encima de 100. Revisa el resultado de la migración en Supabase antes del primer job.

## 2. Secretos de Cloudflare Workers

Desde `worker/`, instala y despliega el Worker:

```powershell
npm install
npx wrangler secret put BCCR_API_TOKEN
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put CRON_TRIGGER_SECRET
npx wrangler deploy
```

Wrangler solicita el valor de cada secreto en la terminal. No los guardes en HTML, `script.js`, `wrangler.toml` ni Git. `CRON_TRIGGER_SECRET` protege la ruta de actualización manual; crea un valor largo y aleatorio.

El cron de Wrangler está a las 00:30 UTC, que corresponde a las 18:30 de Costa Rica. El Worker consulta los indicadores 423 (TBP), 23698 (TED), 317 (compra), 318 (venta) y 3541 (TPM). Si el BCCR no responde o el dato no cambia, conserva el último valor válido y actualiza el estado de consulta sin insertar un valor duplicado.

## 3. Conectar la página con el Worker

Después de `wrangler deploy`, copia la URL `*.workers.dev` que muestra Wrangler. Si el Worker está en un origen separado de Cloudflare Pages, configura en el `<meta name="api-base">` de `index.html` la URL completa terminada en `/api`, por ejemplo:

```html
<meta name="api-base" content="https://calculadora-finanzas.TU-SUBDOMINIO.workers.dev/api" />
```

Si el Worker ya tiene una ruta `/api/*` en el mismo dominio de la página, conserva `/api`. La API es pública para leer tasas y hacer cálculos; no requiere ni recibe secretos del BCCR o de Supabase desde el navegador.

## 4. Probar en desarrollo y actualizar tasas manualmente

Para desarrollo local, crea `worker/.dev.vars` (está excluido de Git) con tus propios valores:

```dotenv
BCCR_API_TOKEN=...
SUPABASE_URL=https://TU-PROYECTO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
CRON_TRIGGER_SECRET=...
```

Luego:

```powershell
cd worker
npx wrangler dev
```

Verifica `GET http://localhost:8787/api/health` y `GET http://localhost:8787/api/rates`. Para lanzar el job manualmente, envía el secreto configurado en `.dev.vars`:

```powershell
$jobHeaders = @{ "X-Job-Secret" = "EL_VALOR_DE_CRON_TRIGGER_SECRET" }
Invoke-RestMethod -Method Post -Uri http://localhost:8787/api/bccr/refresh -Headers $jobHeaders
```

Rutas disponibles: `GET /api/health`, `GET /api/rates`, `GET /api/rates/{codigo}`, `POST /api/loans/calculate`, `POST /api/debt/strategies` y `POST /api/bccr/refresh`. La última requiere el encabezado `X-Job-Secret` con el secreto local o de entorno; no la invoques desde el frontend.

La ruta de cálculo de préstamos acepta `principal`, `annualRate` efectiva, `months`, `extraPayment`, `extraMode` (`reduceTerm` o `reducePayment`), `extraStartMonth` y una lista opcional de cambios de tasa `{ month, annualRate }`. La simulación de deudas acepta `monthlyBudget` y una lista de saldos, tasas efectivas y pagos mínimos. La interfaz envía al Worker solo valores financieros numéricos para la comparación, sin el nombre de la deuda ni las filas de comercios.

## Privacidad del visor

PDF.js renderiza el documento en un canvas local y Tesseract.js ejecuta OCR en el navegador sobre copias con las zonas negras ya aplicadas. El original y las copias rasterizadas viven en memoria; no se envían a la API, no se guardan en disco ni en Supabase. Revisa los campos y la tabla editable antes de guardar: el consentimiento conserva únicamente los datos financieros anonimizados en el `localStorage` de ese navegador. También puedes ingresar las filas manualmente.

PDF.js, Tesseract.js y el modelo de idioma español se cargan desde sus CDN; el contenido del documento se procesa localmente y no se adjunta a las solicitudes de esos recursos.
