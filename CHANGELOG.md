# Changelog

Los cambios de cada versión de `rayacash-cli` publicada en [npm](https://www.npmjs.com/package/rayacash-cli). Sigue [semver](https://semver.org/lang/es/): los cambios incompatibles solo llegan en una versión mayor (`2.0.0`), y los anotamos acá.

## 1.0.0

Primera versión: escuchá en tu máquina los eventos de webhooks de tu sandbox y reenvialos a tu servidor local, con el mismo body y los mismos headers que una entrega real. Es para las cuentas que tienen sandbox (si en el menú de tu perfil del dashboard aparece «Crear sandbox» o «Sandboxes»).

- `rayacash login` guarda tu clave secreta de prueba (`raya_sk_test_…`) en un archivo que solo tu usuario puede leer; `rayacash logout` la borra. Las claves de tu cuenta real se rechazan sin mandarlas.
- `rayacash listen` escucha los eventos de pagos y de órdenes de Connect (todos, o los que elijas con `--events`, como `-e 'payment.*'`) y, con `--forward-to`, reenvía cada evento a tu servidor firmado con el secreto de tu máquina (`--print-secret`), sin seguir redirecciones y esperando la respuesta hasta 15 segundos.
- `--json` muestra cada evento tal como llega; `--skip-verify` acepta el certificado propio de tu servidor local.
- Si se corta la conexión, reintenta solo y, si el corte fue corto, te llega lo que pasó mientras tanto.
- Sin dependencias: Node.js 22 o más nuevo, en Linux, macOS y Windows.
