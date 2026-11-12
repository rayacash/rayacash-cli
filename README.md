# rayacash-cli

Escuchá en tu máquina los webhooks de tu sandbox de Raya Cash y reenvialos a tu servidor local, firmados como una entrega real: no hace falta publicar una URL ni abrir un túnel. Es para las cuentas que tienen sandbox (si en el menú de tu perfil del dashboard aparece «Crear sandbox» o «Sandboxes»).

```bash
npm install -g rayacash-cli
rayacash login
rayacash listen --forward-to localhost:3000/webhooks/raya
```

Versión 1.0.0. Requiere Node.js 22 o más nuevo. Los cambios de cada versión están en [CHANGELOG.md](CHANGELOG.md).

## Contenido

- [Antes de empezar](#antes-de-empezar)
- [Instalación](#instalación)
- [Iniciar sesión](#iniciar-sesión)
- [Escuchar eventos](#escuchar-eventos)
- [Verificar la firma en tu servidor](#verificar-la-firma-en-tu-servidor)
- [Cómo se entregan](#cómo-se-entregan)
- [Configuración](#configuración)
- [Salida y códigos de salida](#salida-y-códigos-de-salida)
- [Seguridad](#seguridad)
- [Versionado y compatibilidad](#versionado-y-compatibilidad)
- [Desarrollo](#desarrollo)

## Antes de empezar

1. **Node.js 22 o más nuevo.**
2. **Un sandbox.** Si en el menú de tu perfil del dashboard aparece «Crear sandbox» o «Sandboxes», tu cuenta ya puede usar el sandbox: creá uno y entrá. Si no aparece, tu cuenta todavía no lo tiene.
3. **La clave secreta de prueba del sandbox** (`raya_sk_test_…`), en Developers › API Keys, adentro del sandbox.
4. **Un endpoint en tu servidor local** que reciba los eventos y verifique la firma (ver [Verificar la firma en tu servidor](#verificar-la-firma-en-tu-servidor)).

## Instalación

```bash
npm install -g rayacash-cli
```

Instala dos comandos iguales, `rayacash` y `rayacash-cli`. No tiene dependencias.

Sin instalar nada, con `npx`. Ahí los comandos de esta guía van con `npx rayacash-cli` en lugar de `rayacash`:

```bash
npx rayacash-cli login
npx rayacash-cli listen --forward-to localhost:3000/webhooks/raya
```

También podés instalar una versión directo desde GitHub. Necesita git instalado (no compila nada: el repo trae el código listo):

```bash
npm install -g github:rayacash/rayacash-cli#v1.0.0
```

## Iniciar sesión

```bash
rayacash login
```

Te pide la clave secreta de prueba de tu sandbox sin mostrarla y la guarda en esta máquina, en un archivo que solo tu usuario puede leer. También podés pasarla con `rayacash login --api-key raya_sk_test_…` (queda en el historial de tu terminal; con npx, nunca `--api-key`: npm anota el comando, con la clave, en sus logs) o desde otro comando: `printf %s "$KEY" | rayacash login`. En Git Bash, si la terminal no oculta lo que escribís, pegá la clave y apretá Enter.

`rayacash listen` usa la primera que encuentre:

1. `--api-key raya_sk_test_…` (mientras escuchás, queda visible en la lista de procesos de tu máquina: mejor alguna de las otras dos; con npx, nunca `--api-key`, porque npm la anota en sus logs);
2. la variable de entorno `RAYA_SECRET_KEY` de la terminal donde lo corrés (no lee tu `.env`), la misma que usan los SDKs. Si tiene una clave de tu cuenta real, la ignora y te avisa; si tiene otra clave de prueba, le gana a la guardada (`rayacash login` te avisa);
3. la que guardaste con `rayacash login`.

Con `npx`, sin login: `RAYA_SECRET_KEY=raya_sk_test_… npx rayacash-cli listen --forward-to localhost:3000/webhooks/raya`.

Solo acepta la clave secreta de prueba (`raya_sk_test_…`). Una clave de tu cuenta real (`raya_sk_live_…`) la rechaza sin mandarla a ningún lado.

`rayacash logout` borra la clave guardada. El secreto de firma no cambia.

## Escuchar eventos

```bash
rayacash listen --forward-to localhost:3000/webhooks/raya
```

```
Listo. Escuchando el sandbox «Mi tienda» (sbx_9fKc2LmQ8rT1uVwXyZ0aBcDe) con la clave raya_sk_test_…AbCd.
Eventos: payment.created, payment.succeeded, payment.failed, payment.refunded, connect.order.created, connect.order.succeeded, connect.order.failed, connect.order.refunded
Reenviando a http://localhost:3000/webhooks/raya
Secreto de firma: whsec_EjemploNoReal-3xKqP0aZbY_cXdWeVfUgThSiRjQkP  (en tu servidor, como RAYA_WEBHOOK_SECRET)
Ctrl+C para salir.
2026-11-12 10:31:02  --> payment.created [evt_8Hq2LxV0aBcDeFgHiJkLmNoP]
2026-11-12 10:31:02  <-- [200] POST http://localhost:3000/webhooks/raya [evt_8Hq2LxV0aBcDeFgHiJkLmNoP] 18 ms
```

- **Abrí la escucha antes de simular**: te llegan los eventos que ocurren mientras está abierta. Los de un pago que simulaste antes no te llegan.
- `--forward-to` (`-f`) es la URL de tu servidor; sin esquema, va con `http://`. Con Django, FastAPI o PHP, por ejemplo, `-f localhost:8000/webhooks/raya`. Sin `--forward-to`, solo mostramos los eventos.
- `--events` (`-e`) elige qué eventos escuchar, separados por comas o repitiendo la opción. Por defecto, todos los de un sandbox:
  - `payment.created`, `payment.succeeded`, `payment.failed` y `payment.refunded`, de tus pagos de prueba;
  - `connect.order.created`, `connect.order.succeeded`, `connect.order.failed` y `connect.order.refunded`, de las órdenes de tus apps del sandbox.

  También `'payment.*'` y `'connect.order.*'`, siempre entre comillas: sin ellas, la terminal los cambia por nombres de archivos o, en zsh (la de macOS), falla con «no matches found» antes de correr el comando (fish, con «No matches for wildcard»). Por ejemplo:

  ```bash
  rayacash listen -e payment.succeeded,payment.failed -f localhost:3000/webhooks/raya
  rayacash listen -e 'connect.order.*' -f localhost:3000/webhooks/raya
  ```

- `--json` muestra cada evento como una línea de JSON, tal como llega; las líneas `-->` y `<--` pasan a la salida de errores. Por ejemplo: `rayacash listen --json | jq .type`.
- `--skip-verify` no verifica el certificado si tu servidor local usa `https` con un certificado propio. Si usás una CA propia, también podés sumarla con `NODE_EXTRA_CA_CERTS`. Solo vale para el reenvío: la conexión con Raya Cash siempre se verifica, aunque tengas `NODE_TLS_REJECT_UNAUTHORIZED=0` (tu clave viaja ahí). Si tu red (un proxy de tu empresa o un antivirus) intercepta HTTPS, sumá su CA con `NODE_EXTRA_CA_CERTS`.
- Los eventos llevan `livemode: false`. «Enviar evento de prueba» del dashboard va solo al destino que elegiste: no llega a la escucha.
- Si se corta la conexión, reintentamos solos. Si el corte es corto, al volver te llega lo que pasó mientras tanto; si fue largo, te avisamos que los eventos de ese rato pueden no haberte llegado.
- `Ctrl+C` deja de escuchar. En Windows, si corrés con `npx` o desde `cmd.exe`, Windows puede preguntarte después «¿Desea terminar el trabajo por lotes (S/N)?» (también en PowerShell: npx corre el comando con `cmd.exe`). Es de `cmd.exe` y da lo mismo lo que respondas.

## Verificar la firma en tu servidor

Cada evento llega firmado en `Raya-Signature`, con el mismo esquema que una entrega real pero con **el secreto de esta máquina**, no con el de un destino de Developers › Webhooks. Lo ves al arrancar y con:

```bash
rayacash listen --print-secret
```

Guardalo en tu servidor como `RAYA_WEBHOOK_SECRET` mientras probás (en producción va el secreto de tu destino):

```bash
export RAYA_WEBHOOK_SECRET="$(rayacash listen --print-secret)"
```

En PowerShell: `$env:RAYA_WEBHOOK_SECRET = (rayacash listen --print-secret)`. Con `npx`, copiá el `whsec_…` que muestra `npx rayacash-cli listen --print-secret` a tu `.env`, o usá `npx --yes` adentro de `$(…)` para que npx no te pregunte nada ahí:

```bash
export RAYA_WEBHOOK_SECRET="$(npx --yes rayacash-cli listen --print-secret)"
```

Con el SDK de Node (`npm install rayacash express`):

```js
import express from "express";
import { Webhook } from "rayacash";

const app = express();

app.post("/webhooks/raya", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = Webhook.constructEvent(req.body, req.get("Raya-Signature"), process.env.RAYA_WEBHOOK_SECRET);
  } catch {
    return res.status(400).send("Firma inválida");
  }
  console.log(event.type, event.id, event.livemode); // en un sandbox, livemode es false
  return res.sendStatus(200);
});

app.listen(3000);
```

En Python, `rayacash.Webhook.construct_event(payload, sig_header, secret)`; en PHP, `RayaCash\Webhook::constructEvent($payload, $sigHeader, $secret)`. El secreto es el mismo en cada corrida y para todos tus sandboxes, y `rayacash logout` no lo cambia.

## Cómo se entregan

- Un `POST` por evento, con el body exacto del evento y los headers de una entrega real: `Content-Type: application/json`, `User-Agent: Raya-Webhooks/1.0`, `Raya-Event-Id`, `Raya-Event-Type`, `Raya-Delivery-Id` y `Raya-Signature`.
- Respondé `2xx` en menos de 15 segundos. No seguimos redirecciones: una respuesta `3xx` cuenta como fallida.
- Un solo intento: si tu servidor falla o no responde, lo mostramos y seguimos con el siguiente. Para probar de nuevo, simulá otro pago.
- En producción, un evento puede llegar más de una vez y desordenado: deduplicá por `Raya-Event-Id` y no dependas del orden.
- Lo que reenvía la escucha no aparece en Developers › Webhooks: lo ves en tu terminal.

## Configuración

- Linux y macOS: `~/.config/rayacash/config.json` (o `$XDG_CONFIG_HOME/rayacash/config.json`). Windows: `%APPDATA%\rayacash\config.json`.
- Guarda la clave (`api_key`) y el secreto de firma (`webhook_secret`). En Linux y macOS el archivo queda con permisos `600` y la carpeta con `700`; si alguien más lo puede leer, te avisamos. En Windows lo protegen los permisos de tu perfil.
- Para empezar de cero, borralo (también cambia el secreto de firma).
- rayacash-cli 1.0 no configura proxies por su cuenta.

## Salida y códigos de salida

- Los eventos van a la salida estándar; los avisos y los errores, a la de errores. Con `--print-secret`, la salida estándar trae solo el secreto.
- Sin colores con `NO_COLOR` o si la salida no es una terminal; `FORCE_COLOR=1` los fuerza.

| Código | Cuándo |
|---|---|
| `0` | Terminó bien, también al cortar con `Ctrl+C`. |
| `1` | Raya Cash rechazó la clave o tu cuenta, el sandbox de tu cuenta no está disponible al arrancar, tu versión no es compatible, no pudimos leer o guardar la configuración, tu Node.js es anterior al 22, o un error inesperado. |
| `2` | Error de uso: una opción, un evento o una URL inválidos, o una clave con formato inválido o de tu cuenta real. |
| `130` | Cortaste con `Ctrl+C` mientras te pedíamos la clave, o apretaste `Ctrl+C` otra vez, un segundo o más después, porque no terminaba. |

## Seguridad

- La clave queda en un archivo que solo tu usuario puede leer y nunca la mostramos entera (`raya_sk_test_…AbCd`). No la subas a tu repositorio.
- Con `--api-key`, la clave queda visible en la lista de procesos mientras escuchás: mejor guardala con `rayacash login` o usá `RAYA_SECRET_KEY`. Con npx, nunca `--api-key`: npm anota el comando, con la clave, en sus logs (`~/.npm/_logs`). Si ya pasó, borrá esos logs y, si era una clave de tu cuenta real, rotala.
- Solo acepta claves secretas de prueba: nada de lo que hagas con `rayacash` mueve plata.
- No abre puertos: le pregunta a la API de Raya Cash, por HTTPS y con tu clave, si hay eventos nuevos, y solo manda a la URL que le diste. El certificado de la API se verifica siempre.
- Antes de firmar, comprueba que cada evento sea de un sandbox (`livemode: false`) y de uno de los tipos que pediste: si no, no lo reenvía.
- El secreto de firma es de tu máquina. Si se filtra, borrá la configuración y volvé a correr `rayacash login`.

## Versionado y compatibilidad

- [Semver](https://semver.org/lang/es/): los cambios incompatibles solo llegan en una versión mayor (`2.0.0`). Todo queda anotado en el [CHANGELOG](CHANGELOG.md).
- Node.js 22 o más nuevo, en Linux, macOS y Windows.
- Si la API cambia y tu versión deja de ser compatible, `rayacash` te lo dice: actualizala con `npm install -g rayacash-cli`. Con npx, `npx rayacash-cli@latest listen …` corre la última.

## Desarrollo

```bash
npm ci                    # dependencias de desarrollo
npm test                  # tests con node:test (nunca salen de tu máquina)
npm run test:coverage     # lo mismo, con cobertura mínima
npm run lint && npm run typecheck
npm run compile           # src → dist (dist se commitea: CI comprueba que esté al día)
npm run check:package     # compila, publint y el paquete instalado desde el .tgz
```

Para publicar una versión: subila con `npm version patch|minor|major --no-git-tag-version` (también recompila `dist`), actualizá el CHANGELOG y la línea «Versión» de este README, y creá un release `vX.Y.Z` en GitHub. El workflow `release.yml` corre los chequeos y publica en npm con Trusted Publishing. Conviene que el environment `npm` de GitHub acepte deployments solo desde tags `v*` y, si querés, que pida un revisor.

---

Referencia de la API: https://raya.cash/api · Soporte: soporte@raya.cash

Raya Cash S.A
