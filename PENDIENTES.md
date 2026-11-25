# Pendientes e integración

## Integración oficial del BCCR

- Confirmar credenciales, token, suscripción y límites de uso del servicio SDDE.
- Definir el contrato de cada indicador: TBP, TED, TPM y topes máximos legales.
- Implementar un job diferenciado por frecuencia:
  - TBP/TED/TPM: consulta diaria o semanal.
  - Topes legales: revisión periódica o semestral.
- Conservar `valid_from`, `fetched_at`, fuente y estado de vigencia.
- Mantener la última tasa válida ante fallos, respuestas vacías o cambios de formato.
- Validar rangos numéricos y rechazar valores nulos.
- Registrar ejecuciones, errores, tiempos de respuesta y fallos en un proveedor de logs.
- Agregar pruebas unitarias y de integración con datos de ejemplo y respuestas simuladas del BCCR.
- Definir responsabilidad jurídica y procedimiento para cambios en topes legales.

## Historial y recálculo

- [x] Guardar en cada escenario local los parámetros, la tasa base, spread, referencia BCCR, fecha de vigencia y resultados originales.
- [x] Recalcular tasas fijas y variables (TBP/TED/TPM + spread) con el último dato disponible en o antes de la fecha elegida.
- [x] Guardar la fecha de corte del escenario y la fecha elegida para cada recálculo.
- [x] Mostrar diferencias de cuota, intereses y total pagado frente al escenario original.
- [ ] Ampliar la retención del historial BCCR más allá de las últimas 30 observaciones y decidir si los escenarios deben persistirse fuera de este navegador.

## Visor previo y privacidad

- [x] Implementar OCR local para PDF e imágenes.
- [x] Procesar PDF con PDF.js en el navegador.
- [x] Permitir censura manual visual por bloques sobre PDF e imágenes.
- Agregar detección asistida editable de cédula, DIMEX, correo, teléfono, dirección, tarjeta y nombres.
- Separar los datos confirmados del documento original.
- Implementar confirmación de borrado y una política de retención explícita.
- No subir documentos ni PII a servidores externos.
- Revisar la eliminación real de archivos temporales del navegador.
- Agregar auditoría de consentimiento y de cambios manuales.

## Extracción financiera

- [x] Extraer y validar fecha, monto, cuota, saldo al corte, pago mínimo y tasa; comercio/concepto permanece editable y manual.
- [x] Marcar como dudosos los valores repetidos, ilegibles o fuera de rango y exigir corrección manual antes de guardar.
- [x] Descartar filas de consumo sin fecha o monto válido y evitar guardar resúmenes sin ningún monto financiero válido.
- [ ] Definir campos obligatorios por tipo de documento; los campos no detectados se informan, pero pueden permanecer vacíos en un resumen parcial.
- Evitar almacenar nombres, números de cuenta, cédulas o información de tarjetas.

## Seguridad y producción

- Evaluar migración de localStorage a almacenamiento cifrado del servidor solo si la arquitectura lo requiere.
- Agregar autenticación y autorización si la aplicación pasa de demostración a servicio multipersonal.
- Agregar CORS, CSP, rate limiting y protección de endpoints si se crea backend.
- Configurar copias de seguridad, borrado seguro y exportación de datos.
- Crear pruebas de privacidad y regresión financiera.

## Referencias financieras consultadas

- BNCR calcula por moneda, monto solicitado y plazo estimado.
- Colones: muestra el monto mínimo y máximo propio de cada producto.
- Dólares: vivienda tiene hasta 20 años; colones puede llegar hasta 30 años.
- Gastos personales consultados: tasa desde 16.51%, monto máximo ₡100,000,000 y mínimo ₡300,000.
- Unificación consultada: tasa desde 11.5% y monto expresado en dólares/colones según selección.
- Vivienda consultada: tasa desde 8.6% y plazo máximo de 30 años en colones.
- Las tasas mostradas son desde referencias orientativas y pueden variar según crédito, garantía, plazo, seguros y análisis formal.

## Estado actual

Avances implementados en esta iteración:

- Fecha de corte obligatoria al guardar una simulación.
- Snapshot local con moneda, tasa, spread, plazo, cronograma e indicadores calculados.
- Historial visible de escenarios con restauración y borrado.
- Validación de monto, tasa y plazo antes de guardar.
- Límite de vivienda a 20 años en USD y 30 años en CRC.
- Campos financieros editables en el visor privado.
- Extracción validada de fecha, montos, cuota, saldo, pago mínimo y tasa; advertencias de campos no detectados o ambiguos.
- Snapshot de tasa BCCR y recálculo histórico local con comparación de cuota, intereses y total.
- Limpieza de campos privados al descartar el documento.


Implementado en esta versión:

- Amortización mensual tipo francés.
- Tasa fija y variables representadas con spread configurable.
- Tabla, gráfico y exportación CSV.
- Guardado local de escenarios.
- Historial manual inmutable de tasas.
- Lectura local de TXT y CSV.
- Vista previa local básica de imágenes.
- Detección inicial de patrones comunes.
- Confirmación manual antes de guardar datos financieros resumidos.

Pendiente de integración real:

- Confirmar credenciales/límites y validar despliegue de la API BCCR/SDDE en producción.
- Pruebas automatizadas de integración BCCR y regresión de privacidad financiera.
- Definir si se requiere autenticación y almacenamiento persistente seguro para un servicio multipersonal.
