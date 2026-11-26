# Estado de implementación y pendientes

## Implementado y validado

### API del BCCR y Worker
- [x] Worker desplegado en Cloudflare: `https://calculadora-finanzas.developpage.workers.dev`.
- [x] Proyecto Supabase conectado; el endpoint `GET /api/rates` devuelve datos desde sus tablas.
- [x] Job manual ejecutado con éxito y cinco indicadores recibidos del BCCR: TBP (423), TED (23698), compra (317), venta (318) y TPM (3541).
- [x] Cron configurado para todos los días a las 18:30, hora de Costa Rica (00:30 UTC).
- [x] Rutas de salud, tasas, historial por indicador, cálculo de préstamos, estrategias de deuda y actualización protegida del BCCR.
- [x] Lecturas del historial limitadas a un máximo de 365 observaciones por indicador. La serie disponible crece con las observaciones que el sistema guarda; no se hizo una carga retrospectiva completa de 365 días.
- [x] Se conservan datos válidos cuando falla una consulta y no se agrega una fila si el valor de la tasa no cambió.
- [x] El alcance acordado excluye las tasas activas promedio y los topes de la Ley de Usura.

### Calculadora, deudas e historial
- [x] Amortización mensual tipo francés, tasas fijas y variables, spread, pagos extra, cronograma, gráfico y exportación CSV.
- [x] Comparación de estrategias de deuda avalancha y bola de nieve.
- [x] Guardado local de escenarios con snapshot, restauración, borrado y recálculo histórico frente al dato BCCR disponible en la fecha elegida.
- [x] Conversión de moneda con los tipos de cambio de compra y venta.

### Visor y extracción local
- [x] Lectura local de PDF e imágenes, censura manual por bloques, aplanado de la imagen y OCR local en el navegador.
- [x] Extracción editable de campos financieros y consumos, validaciones, advertencias para valores ambiguos y entrada manual alternativa.
- [x] El documento original no se envía a la API ni se guarda en Supabase; los resúmenes aceptados se guardan localmente en el navegador.

## Pendiente de completar o verificar

### Publicación y verificación funcional
- [x] El Worker público responde en `https://calculadora-finanzas.developpage.workers.dev/api/health` y entrega las cinco tasas de `GET /api/rates`.
- [ ] Publicar en Cloudflare Pages la versión de `index.html` que ya apunta a `https://calculadora-finanzas.developpage.workers.dev/api`.
- [ ] Abrir el dominio público final y confirmar que carga las tasas, el filtro por moneda, la tendencia, “Usar en calculadora” y los módulos de préstamo/deudas.
- [x] Verificar desde `http://127.0.0.1:5500/` el cálculo local, el filtro por moneda, “Usar en calculadora”, el guardado/restauración local y una vista estrecha sin desborde horizontal detectable.
- [x] El cron automático ejecutó correctamente en su horario UTC y dejó TBP, TED, compra, venta y TPM con estado `ok` el 2026-11-26.
- [ ] Revisar los logs de Cloudflare y confirmar retención/alertas/reintentos si una consulta falla.

### Privacidad y extracción
- [x] Definir campos mínimos para estados de tarjeta, préstamos y otros documentos; los datos incompletos se etiquetan como resumen parcial y pueden guardarse si incluyen un monto o consumo válido.
- [x] Añadir detección asistida de correo, teléfono, identificación, dirección, tarjeta y nombres/titulares etiquetados en concepto y comercios; el texto sigue siendo editable y debe corregirse antes de guardar. La censura visual del documento continúa siendo manual.
- [x] Proyectar el resumen local a una allowlist de campos y no persistir propiedades OCR ni datos adicionales de transacciones.
- [x] Añadir confirmación para borrar escenarios, resúmenes y datos temporales locales, conservando la caché pública del BCCR.
- [x] Definir retención local de 90 días para escenarios y resúmenes; la purga se ejecuta al abrir la página. Archivos y texto OCR siguen en memoria hasta descartar el documento o cerrar/recargar la página.
- [x] Registrar fecha y versión del consentimiento en cada resumen guardado; no se conserva historial de cada edición manual.

### Seguridad, operación y calidad
- [x] Añadir allowlist CORS, límite de 16 KiB para JSON, proyección de campos numéricos y binding de rate limiting para cálculos.
- [ ] Configurar `CORS_ALLOWED_ORIGINS` con el dominio público definitivo y desplegar el Worker actualizado.
- [x] Verificar públicamente que `GET /api/health` responde `ok: true`, `GET /api/rates` devuelve las cinco referencias con estado `ok` y los POST de préstamo/deudas responden 200 con datos ficticios.
- [x] Definir CSP y encabezados de seguridad en `_headers`.
- [ ] Verificar CSP, rate limiting y encabezados en el dominio público antes de ampliar el uso.
- [ ] Confirmar directamente con el BCCR las cuotas, límites, vigencia y condiciones operativas del token. La API pública consultó correctamente las cinco referencias, pero el portal público no expuso una política numérica verificable de cuotas. Canal oficial: Centro de Atención del BCCR, https://atencion.bccr.fi.cr/csm?id=bccr_aic_contactenos, o central telefónica +506 2243-3333.
- [ ] Completar la verificación operativa: el Worker registra éxitos, duración y errores, y purga logs de más de 30 días; falta confirmar la política en Supabase y configurar alertas externas.
- [ ] Ejecutar y documentar las pruebas automatizadas existentes; se añadieron pruebas simuladas de integración BCCR y regresión de privacidad. La ejecución desde el chat requiere que el directorio remoto `vsls:/` esté montado en el terminal local; el terminal actual no puede acceder físicamente a `worker/package.json`.
- [x] Probar el visor manualmente en `http://127.0.0.1:5500/`: carga de imagen, extracción de campos ficticios, consumos CSV, consentimiento, guardado local, deuda desde resumen, estrategias Avalancha/Bola de nieve y borrado local.
- [x] Crear `informacion/estado-prueba-ocr.html` y probar OCR de un PDF ficticio de una página: detectó fecha, monto, cuota, saldo, tasa, pago mínimo y dos consumos con los valores esperados.
- [ ] Revisar la precisión de las simulaciones y del OCR con PDFs/imágenes reales de distintos bancos y dispositivos.

### Decisiones futuras, fuera del alcance actual
- [ ] Persistencia de escenarios en servidor: decidir autenticación, permisos y retención antes de guardar datos de usuario fuera del navegador.
- [ ] Autenticación/autorización multipersonal si el producto evoluciona a un servicio con cuentas.
- [ ] Tasas activas promedio y topes de Ley de Usura: no incluidos en esta fase por decisión de alcance; reabrir solo si se decide añadirlos.
- [ ] Responsabilidad jurídica y proceso de actualización si se agregan indicadores legales.

## Referencias financieras consultadas

Los valores y condiciones de BNCR que aparecen en `INVESTIGACION.md` son referencias orientativas, no promesas ni condiciones oficiales para cada usuario. Deben verificarse y fecharse de nuevo antes de usarlos como información vigente.
