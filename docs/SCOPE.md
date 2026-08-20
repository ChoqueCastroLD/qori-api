# qori.cc — Alcance del producto

Sitio de sorteos de **productos físicos** con boletos, **provably-fair**, para **LatAm**.
Objetivo: producto completo y confiable, no un MVP recortado.

## Decisiones tomadas
- **Modelo:** boletos para sortear productos físicos.
- **Región:** LatAm (geo-bloqueo + T&C por país).
- **Pagos:** Yape, Plin, transferencia, MercadoPago, PayPal y cripto.
- **Cuentas:** completas y seguras (email+password) + login social vinculado a la misma cuenta.
- **Boletos:** número único por ticket (aleatorio) + comentario opcional del comprador.
- **Sorteo:** **show gamificado en vivo**, sincronizado para todos, y **provably-fair**: toda la secuencia del show se deriva determinísticamente de la semilla comprometida. La semilla se revela **al terminar** el show (suspenso + verificabilidad).
- **Moneda interna: Lingotes** (1 USD = 10 lingotes). Los boletos se compran con lingotes; los pagos recargan lingotes. Se muestra conversión a monedas LatAm hispanohablantes + México.
- **Referidos:** código por usuario; +10 lingotes por cada boleto que compre un referido. +1 lingote de bono por compra.
- **Cripto:** se implementa al final.
- **Stack:** Astro+React+Tailwind (web) · Bun+Elysia+Prisma (api) · Postgres · Coolify.

## Áreas del producto

### 1. Sitio público
- **Landing:** hero, **3 sorteos activos**, **sorteos pasados con sus ganadores**, "cómo funciona" (explicación provably-fair), sección de confianza/transparencia, FAQ, footer legal.
- **Lista de sorteos** activos.
- **Detalle de sorteo:** galería, precio del boleto, progreso (vendidos/total), cuenta regresiva, botón comprar, **sección fairness** (commitment público + fuente de entropía), bases del sorteo.
- **Página del show en vivo:** anima el sorteo sincronizado por WebSocket (eliminación, bombas, carrera, etc.), con cuenta regresiva antes.
- **Verificador público:** pega los valores publicados y reproduce **todo el show** (no solo el ganador) para confirmar que no hubo trampa.
- **Ganadores / historial.**
- **Páginas legales.**

### 2. Autenticación
- Registro email + contraseña (hash Argon2), verificación de email.
- Login social (Google) **vinculado a la cuenta completa**.
- Sesiones seguras (cookie httpOnly). Roles USER / ADMIN.

### 3. Compra de boletos
- Elegir cantidad → orden PENDING → método de pago.
- Asignación de un **número único aleatorio** por boleto al confirmarse el pago; el comprador puede dejar un **comentario** por ticket.
- Reglas por sorteo: **precio del boleto** (puede ser 0 = gratis), **cupo total** (mín/máx de boletos del sorteo), **máximo de boletos por usuario** (evita acaparamiento).
- Anti-sobreventa: nunca vender más que el cupo (seguro ante concurrencia).

### 3b. El sorteo como show gamificado en vivo
Cuando llega la hora, se corre un **espectáculo animado** que todos ven sincronizado en la página del sorteo. Tipos de juego (cada uno = una forma distinta de *revelar* al/los ganador/es):
- **Eliminación** — se eliminan boletos en orden (`eliminationOrder`, cada X ms) hasta quedar el/los ganador/es.
- **Luz roja / luz verde** (estilo Squid Game) — cambios de luz (`lightState`) van descartando boletos.
- **Carrera de caballos** — los boletos avanzan pasos (`horseSteps`) hasta cruzar la meta.
- **Bombas** — se colocan y explotan boletos por fase (`bombTicketIds`, `blownAt`).
- **Revelado de dígitos** — se descubren los dígitos del número ganador (`revealDigits`, `revealOrder`).

Reglas comunes:
- **Varios ganadores** posibles (`winnersCount`), no solo uno.
- **Se construyen los 5 juegos.** Cada sorteo corre **varias stages en orden aleatorio** (el orden también se deriva de la semilla → auditable), **dejando siempre el juego más vistoso para el final**.
- **Personajes = boletos:** cada boleto se representa con la **foto/avatar circular** de su dueño (o avatar elegido, ver privacidad) como "personaje" del juego.
- **Navegación:** el usuario puede **moverse entre stages** fácilmente (ver la anterior/siguiente, revisar qué pasó) sin perder la sincronía del vivo.
- **Toda la secuencia** (orden de stages, eliminación, bombas, pasos, dígitos) se deriva de `serverSeed + publicEntropy` → 100% reproducible y auditable. Ver `docs/FAIRNESS.md`.
- **Transporte en vivo:** el servidor emite las fases por **WebSocket** en una línea de tiempo; todos los clientes ven lo mismo al mismo tiempo (con reconexión). La semilla se revela al final.
- **Duración:** no importa que el show sea largo; prioriza que todo sea **visible y claro**.

> **Privacidad:** mostrar fotos reales de participantes es dato personal. Por defecto el usuario elige un **avatar/nickname** público (no se fuerza foto real); esto va en T&C y en el panel de usuario.

### 3c. Cuándo se sortea (timing)
- **Cuenta regresiva:** cada sorteo tiene **fecha/hora de sorteo** y un **mínimo de boletos**.
- **Auto-extensión para cuidar el profit:** si llega la hora pero no se alcanzó el mínimo, la fecha se **posterga +24h** (repetible) para dar tiempo a vender. Si aun así no se llega, se cancela y se **reembolsa**.

### 3d. Economía: Lingotes (moneda interna) + Referidos
- **Lingote** = moneda de la plataforma. Tasa fija **1 USD = 10 lingotes**.
- **Recarga:** el usuario compra lingotes con los métodos de pago (PayPal/Yape/Plin/
  transferencia/MercadoPago; cripto luego). Los pagos **financian saldo**, no boletos.
- **Gasto:** los boletos se compran **con lingotes** (`ticketPrice` en lingotes).
- **Circuito cerrado:** los lingotes **solo se gastan** en boletos; no se retiran a
  efectivo. Son créditos de participación (menor riesgo legal, sin KYC/AML pesado).
- **Bono:** **+1 lingote por cada boleto** comprado.
- **Referidos:**
  - Cada usuario tiene un **código de referido** único.
  - El referidor gana **+10 lingotes** solo en la **primera compra** del referido.
  - Anti-abuso: sin auto-referido; se acredita únicamente cuando la primera compra
    del referido está pagada/confirmada; una sola vez por referido.
- **Libro mayor (ledger):** todo lingote se mueve por un **registro append-only**
  (recarga, bono, referido, gasto, reembolso). El saldo = suma del ledger. Auditable.
  Las recompensas de referido/bono se **revierten** si el sorteo se cancela/reembolsa.

### 4. Pagos (recarga de lingotes)
Los pagos **acreditan lingotes** al saldo del usuario (no compran boletos directo).
- **Manuales** (Yape / Plin / transferencia): datos/QR → usuario sube comprobante → admin confirma → se acreditan los lingotes.
- **Automatizados** (webhook acredita):
  - PayPal (checkout + webhook) — primero
  - MercadoPago (checkout + webhook)
  - Cripto USDT (vía proveedor, p. ej. NOWPayments/Coinbase Commerce) — al final
- Estados: PENDING → PAID / FAILED / REFUNDED.
- **Reembolsos:** si un sorteo se cancela o no llega a `minTickets`, se **devuelven los lingotes** gastados al saldo (y se revierten las recompensas de referido asociadas).

### 5. Panel de usuario
- Mis boletos (por sorteo), mis órdenes y su estado, si gané.
- Perfil y datos de contacto.

### 6. Panel de administración (SuperadminRaffles)
- Crear/editar sorteo: título, **premio**, precio del boleto, **cupos** (mín/máx, máx por usuario), **tipo de juego**, `winnersCount`, fecha/hora de sorteo. Genera el commitment automáticamente al abrir.
- Ver órdenes; **aprobar pagos manuales** (revisar comprobante).
- Cerrar ventas → ingresar entropía pública → **lanzar el show** (corre la secuencia y, al terminar, revela la semilla).
- Ver participantes / exportar; gestionar reembolsos y cancelaciones.

### 7. Legal / compliance
- T&C, **bases del sorteo** (por sorteo), privacidad, +18, geo-bloqueo LatAm, aviso de responsabilidad.
- ⚠️ Plantillas marcadas para revisión de abogado local antes de vender el primer boleto.

## Orden de construcción (milestones)
1. **Modelo de datos completo + auth** (cuentas, sesiones, roles, social login).
2. **Sitio público** (landing con 3 activos + pasados/ganadores, lista, detalle, verificador) con datos reales.
3. **Compra + pagos** (PayPal primero; luego Yape/Plin/transferencia con comprobante; MercadoPago; cripto al final).
4. **Motor del show gamificado** (secuencias determinísticas por tipo de juego + verificador de show completo).
5. **Transmisión en vivo** (WebSocket: línea de tiempo, sincronización, reconexión).
6. **Panel de usuario.**
7. **Panel de administración** (SuperadminRaffles).
8. **Timing + auto-extensión** (+24h si no se llega al mínimo).
9. **Legal + geo-bloqueo.**
10. **Deploy en Coolify** (web, api, Postgres, dominio qori.cc).

## Decisiones abiertas (cerrar antes de programar)
- Moneda base (por sorteo vs global).
- Proveedor de cripto (self-host vs NOWPayments/Coinbase Commerce).
- Verificación de email obligatoria antes de comprar (por defecto: sí).
