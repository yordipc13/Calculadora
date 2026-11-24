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

- Persistir snapshots de tasas asociadas a cada simulación.
- Permitir recalcular con tasa fija, TBP + spread, TED + spread y TPM + spread.
- Guardar la fecha de corte usada por cada cálculo.
- Presentar diferencias entre la simulación original y el recálculo.

## Visor previo y privacidad

- Implementar OCR local para PDF e imágenes.
- Evaluar procesamiento de PDF con un visor privado compatible, por ejemplo PDF.js o una biblioteca similar.
- Permitir censura manual visual por bloques sobre PDF e imágenes.
- Agregar detección asistida editable de cédula, DIMEX, correo, teléfono, dirección, tarjeta y nombres.
- Separar los datos confirmados del documento original.
- Implementar confirmación de borrado y una política de retención explícita.
- No subir documentos ni PII a servidores externos.
- Revisar la eliminación real de archivos temporales del navegador.
- Agregar auditoría de consentimiento y de cambios manuales.

## Extracción financiera

- Extraer y validar:
  - fecha
  - comercio o concepto
  - monto
  - cuota
  - saldo al corte
  - pago mínimo
  - tasa
- Marcar campos dudosos para revisión humana.
- Rechazar automáticamente datos incompletos o ambiguos.
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
- Extracción automática preliminar de fecha, montos y tasa.
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

- API de datos del BCCR/SDDE.
- OCR real de PDF e imágenes.
- Censura visual interactiva sobre el documento.
- Backend, autenticación y almacenamiento persistente seguro.
