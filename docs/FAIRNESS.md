# qori.cc — Modelo de imparcialidad (provably-fair)

Este documento es público y auditable. Describe **exactamente** cómo se decide
el resultado de cada sorteo, de forma que cualquiera pueda reproducirlo. El
código que lo implementa (`packages/fair`) es abierto: verifícalo tú mismo.

## Principio

La seguridad **no** depende de ocultar el código, sino de un secreto (la semilla)
y de una entropía pública futura que nadie controla. Es el mismo principio que
TLS o Bitcoin (Kerckhoffs): algoritmo público, clave secreta.

Ningún actor puede, por sí solo, conocer ni elegir el resultado:

| Amenaza | Actor | Mitigación |
|---|---|---|
| Elegir quién gana | Operador (qori) | El resultado depende de entropía pública **futura** que el operador no controla |
| Predecir/comprar el boleto ganador | Usuario | El resultado depende de una **semilla secreta** cuyo hash se publica, pero que se revela solo al final |
| Alterar la lista de participantes | Operador | La **raíz Merkle** de todos los boletos entra en la entropía; cambiarla rompe la verificación |

## Ciclo de un sorteo

```
1. ABRIR
   serverSeed  = 256 bits aleatorios (CSPRNG)        [SECRETO]
   commitment  = sha256(serverSeed)                  [PÚBLICO — se publica ya]

2. VENTA DE BOLETOS
   Cada boleto: número único + dueño (+ comentario).

3. CERRAR VENTAS  (a la hora del sorteo T, tras posibles auto-extensiones)
   ticketsRoot   = raízMerkle(boletos ordenados por número)   [PÚBLICO]
   drandRound    = ronda de drand programada para el instante T   [número conocido de antemano]
   drandValue    = aleatoriedad de esa ronda, con su firma        [PÚBLICO, aparece EXACTO en T]
   publicEntropy = `${drandRound}:${drandValue}:${ticketsRoot}`

4. SORTEO (el show)
   digest = HMAC_SHA256(key = serverSeed, msg = publicEntropy)
   → `digest` siembra un PRNG determinista (HMAC-DRBG por rehashing)
   → del PRNG salen: ganador(es), orden de stages, orden de eliminación,
     posición de bombas, pasos de la carrera, orden de dígitos, etc.
   Todo el show es una FUNCIÓN determinista de (serverSeed, publicEntropy).

5. REVELAR  (al terminar el show)
   Se publica serverSeed. Cualquiera comprueba:
     a) sha256(serverSeed) == commitment         (la semilla es la comprometida)
     b) recomputa el show completo y confirma ganador(es) y cada fase
```

## Por qué es a prueba de trampas

- **El operador no puede elegir el ganador:** se comprometió con `serverSeed`
  *antes* de que existiera `beaconHash` (un bloque de Bitcoin futuro). No puede
  buscar una semilla a medida porque ya está publicada, y no puede minar Bitcoin.
- **Los usuarios no pueden predecir:** no conocen `serverSeed` (solo su hash, que
  es irreversible), y `beaconHash` aún no existe cuando compran.
- **Nadie puede alterar participantes:** `ticketsRoot` sella la lista exacta.
- **Open source no debilita nada:** el atacante necesitaría la semilla real, no
  el algoritmo.

## Por qué drand como faro (beacon)

Un show en vivo debe empezar a una hora exacta. El faro debe dar entropía
impredecible que aparezca **justo** en ese segundo — ni antes (spoiler) ni
después (espera).

- **drand** (League of Entropy) emite aleatoriedad pública **cada 30 s en horario
  fijo**. El número de ronda del instante T se conoce de antemano; su **valor**
  aparece exactamente en T.
- Cada ronda trae una **firma BLS** verificable contra la llave pública de drand
  → auditable por cualquiera, sin confiar en qori.
- Impredecible antes de T e imposible de controlar por el operador.

### ¿Y Bitcoin?
El problema de "primer bloque tras la hora T" es que el bloque aparece **minutos
después** de T (bloques cada ~10 min, variable) → el show empezaría tarde y con
espera de duración impredecible. Por eso **drand es el faro primario**.

Opcional: se puede **anclar además** al siguiente bloque de Bitcoin como
referencia reconocible ("sellado también en BTC #X"), pero el resultado ya quedó
fijado puntualmente por drand; Bitcoin sería solo un segundo testigo, no parte del
cómputo del ganador (para no reintroducir la espera).

## Interacción con la auto-extensión (+24h)

Si no se alcanza el mínimo de boletos a la hora fijada, la hora se posterga +24h.
La regla del beacon se ancla a la **hora final efectiva** del sorteo (la que quede
tras las extensiones), y esa hora queda registrada públicamente en cada extensión.

## Reproducir un sorteo (verificación)

Con estos valores publicados: `commitment`, `serverSeed` (revelado), `beaconHeight`,
`beaconHash`, la lista de boletos (para recomputar `ticketsRoot`) y `winnersCount`,
cualquiera corre el verificador (o el código de `packages/fair`) y obtiene
bit-a-bit el mismo show y los mismos ganadores. Si algo no cuadra, hubo trampa.
