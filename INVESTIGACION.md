# Investigación técnica y regulatoria

## Alcance

Este documento registra la información necesaria para construir una calculadora de deudas y préstamos en Costa Rica. Se enfoca en amortización, tasas oficiales, moneda, privacidad documental y trazabilidad histórica.

## Fuentes oficiales consultadas

- Banco Central de Costa Rica: https://www.bccr.fi.cr/
- Indicadores Económicos / SDDE: https://sdd.bccr.fi.cr/
- TRI: https://sdd.bccr.fi.cr/es/IndicadoresEconomicos/Inicio/Contenedor/410?Cuadro=432
- SUGEF: https://www.sugef.fi.cr/
- Normativa SUGEF: https://www.sugef.fi.cr/normativa/normativa_vigente.aspx
- BNCR, calculadoras públicas: https://www.bncr.fi.cr/calculadora-de-credito
- Banco Nacional, gastos personales: https://www.bncr.fi.cr/personas/financiamiento/calculadora-de-credito/calculadora-gastos-personales
- Banco Nacional, unificación de deudas: https://www.bncr.fi.cr/personas/financiamiento/calculadora-de-credito/calculadora-cuota-unica
- Banco Nacional, vivienda: https://www.bncr.fi.cr/personas/financiamiento/calculadora-de-credito/calculadora-vivienda
- Ley 8968: Protección de las Personas frente al Tratamiento de sus Datos Personales, sistema jurídico oficial: https://sinalevi.go.cr/

## Información financiera confirmada

### Moneda

La simulación debe admitir al menos:

- Colones costarricenses.
- Dólares estadounidenses.

El cálculo debe conservar la moneda original del préstamo. La conversión a otra moneda no debe modificar el contrato ni el saldo original sin declarar explícitamente el tipo de cambio usado.

### Tasas vigentes consultadas

Según el comunicado oficial del BCCR publicado el 18 de noviembre de 2026:

- Tasa Básica Pasiva: 3.56%.
- Tasa Efectiva en Dólares: 3.04%.
- Ambas a partir del 19 de noviembre de 2026.

Estos valores son vigentes al momento de la consulta y no deben quedar fijos en el producto sin comprobación periódica.

La Tasa de Política Monetaria debe obtenerse por el BCCR/SDDE o por un comunicado oficial vigente. No conviene presentar un valor manual permanente.

### TRI

El BCCR publica la TRI por moneda y por plazo:

- Moneda nacional: 1 semana, 1 mes, 3, 6, 9, 12, 24, 36 y 60 meses.
- Moneda extranjera: los mismos horizontes principales.

Para una deuda variable, el plazo de referencia debe coincidir con el contrato. No se debe asumir que toda deuda usa TRI a 1 año o al mismo plazo por defecto.

### Calculadoras públicas consultadas

Gastos personales:

- Moneda: colones o dólares.
- Monto mínimo: ₡300,000.
- Monto máximo mostrado: ₡100,000,000.
- Plazo mostrado: años.
- Tasa desde: 16.51%.

Unificación de deudas:

- Moneda: colones o dólares.
- Monto mínimo mostrado: ₡300,000 o 300,000 según interpretación de moneda.
- Monto máximo mostrado: ₡300,000.
- Plazo mostrado: hasta 9 años.
- Tasa desde: 11.5%.

Vivienda:

- Moneda: colones o dólares.
- Plazo máximo en dólares: 20 años.
- Plazo máximo en colones: 30 años.
- Tasa desde: 8.6%.

Las tasas “desde” son referencias orientativas. La entidad financiera puede ajustar según crédito, garantía, plazo, seguros y condiciones propias. No deben interpretarse como topes legales ni ofertas válidas.

## Modelo de amortización

Campos mínimos:

- principal;
- moneda;
- modalidad de tasa;
- tasa nominal o efectiva aplicada;
- spread, si corresponde;
- indicador base, si corresponde;
- fecha de inicio;
- plazo en meses;
- periodicidad de pago;
- fecha de primer pago;
- períodos de gracia;
- pagos extraordinarios;
- seguros y comisiones, si están disponibles;
- método de pago.

Métodos necesarios:

- tasa fija;
- tasa variable ligada a TBP + spread;
- tasa variable ligada a TED + spread;
- tasa variable ligada a TPM + spread;
- posible tope legal.

Para cada cuota almacenar:

- número de periodo;
- fecha;
- saldo inicial;
- cuota total;
- capital;
- interés;
- seguros o comisiones;
- saldo final;
- tasa aplicada;
- fecha de vigencia de la tasa;
- indicador base;
- spread;
- fuente de la tasa.

La cuota debe calcularse con el método francés como primera versión. No mezclar nominal y efectivo sin normalizar.

## Historial de tasas

Entidades del modelo:

- fuente;
- indicador;
- moneda;
- plazo;
- segmento;
- valor;
- unidad;
- vigencia desde;
- vigencia hasta, si existe;
- fecha de consulta;
- resultado validado;
- identificador de respuesta del proveedor;
- estado de la vigencia.

Reglas:

- una tasa nueva no reemplaza históricamente una anterior;
- toda simulación conserva snapshot de la tasa utilizada;
- el recálculo usa la tasa efectiva que estaba vigente en la fecha seleccionada;
- no se acepta valor vacío, texto no numérico o valor fuera de rango;
- ante fallo se usa la última tasa válida conocida y se marca en la interfaz;
- los topes legales se revisan periódicamente y no se tratan como indicadores diarios;
- la TBP/TED/TPM deben obtenerse por fuente oficial o job autenticado.

Frecuencias iniciales recomendadas:

- TBP: consultar al menos antes de recalcular y validar cambios oficiales.
- TED: consultar al menos antes de recalcular y validar cambios oficiales.
- TPM: consulta según publicación oficial y vigencia.
- TRI: según su plazo publicado y vigencia.
- topes legales: revisión periódica, además de cambio publicado.

## Visor documental y privacidad

Principios mínimos:

- procesar inicialmente en el navegador;
- no enviar PII al servidor antes de revisión;
- mostrar qué campos serán conservados;
- censura visual manual obligatoria o confirmada;
- confirmación separada del procesamiento y del almacenamiento;
- borrar el documento original después de aprobar;
- conservar solo datos anonimizados necesarios;
- registro de consentimiento sin guardar PII innecesaria.

Datos a conservar:

- fecha;
- comercio o concepto;
- monto;
- cuota;
- saldo al corte;
- pago mínimo;
- tasa;
- fecha de extracción;
- identificador anónimo de deuda;

Datos a excluir:

- nombre completo;
- cédula/DIMEX;
- correo;
- teléfono;
- dirección;
- número de tarjeta;
- código de cuenta;
- número de contrato completo;
- contenido libre no requerido.

La Ley 8968 exige base y finalidad claras para el tratamiento de datos personales, atención a derechos de acceso, rectificación, cancelación y oposición, cuando corresponda, y resguardo de datos tratados. Debe agregarse aviso de privacidad específico antes de capturar documentos reales.

## Requisitos técnicos

Frontend:

- validación de entradas;
- moneda dependiente del contrato;
- plazo en meses internamente;
- tasa anual normalizada;
- tabla mensual;
- exportación sin PII;
- snapshot visible en cada simulación;
- fecha de vigencia junto a la tasa;
- advertencia si usa datos vencidos o manuales.

OCR y PDF:

- PDF.js o solución equivalente para renderizar;
- OCR local si está disponible;
- detección asistida configurable;
- censura visual en canvas;
- extracción editable;
- validación antes de guardar;
- eliminación del archivo temporal.

Backend futuro:

- autenticación;
- autorización por usuario;
- cifrado en tránsito y reposo;
- cifrado de backups;
- registro de auditoría;
- rate limiting;
- CSP;
- CORS restringido;
- retención mínima;
- borrado de datos bajo solicitud;
- pruebas de acceso indebido y fuga de PII.

## Riesgos que requieren diseño explícito

- confundir tasa básica con costo efectivo;
- presentar el valor “desde” como tasa garantizada;
- mezclar colones y dólares sin tipo de cambio;
- usar 360, 365 o días reales de forma inconsistente;
- asumir cuota fija ante una tasa variable;
- excluir seguros, comisiones o períodos de gracia;
- sobrescribir tasas históricas;
- conservar PII fuera del visor;
- mostrar OCR sin confirmación humana;
- dar vigencia a datos sin fecha;
- permitir guardar documentos PDF originales.

## Pendientes antes de producción

1. Obtener contrato o suscripción oficial al SDDE y documentar endpoints, token y límites.
2. Confirmar nombres exactos de series para TBP, TED, TPM, TRI y topes legales.
3. Confirmar la periodicidad vigente de TPM y topes.
4. Definir método oficial de costo efectivo total aplicable al producto.
5. Definir períodos de gracia, periodos de pago y fechas.
6. Contratar o configurar OCR local con licencia compatible.
7. Crear modelo jurídico y flujo de consentimiento para PII.
8. Implementar eliminación real de documentos temporales y registros.
9. Revisar las normas vigentes completas de SUGEF/CONASSIF antes de afirmar cumplimiento.
10. Realizar pruebas financieras independientes con ejemplos conocidos.
