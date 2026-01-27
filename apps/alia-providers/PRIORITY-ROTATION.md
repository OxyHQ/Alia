# Sistema de Rotación de Prioridades

## 🎯 Concepto

El sistema NO usa cooldown ni desactivaciones temporales. En su lugar, usa **rotación dinámica de prioridades**:

- **Key falla** → Se mueve al final de su grupo (free/paid)
- **Key funciona** → Vuelve a su prioridad original
- **Siempre disponible** → Nunca se bloquea, solo cambia de orden

## 🏗️ Grupos de Prioridad

### Grupo 1: Keys Gratuitas (Free)

```
Priority:  1    2    3    4
Keys:    [Key1][Key2][Key3][Key4]
         ↑ Se intenta primero

Si Key1 falla → Se mueve al final:
Priority:  2    3    4    5
Keys:    [Key2][Key3][Key4][Key1]
                              ↑ Ahora está al final
```

### Grupo 2: Keys de Pago (Paid)

Solo se usan si **TODAS** las free están rate-limited o fallaron.

```
Free grupo:  [Key1][Key2][Key3]  ← Se intentan PRIMERO
Paid grupo:  [KeyA][KeyB]        ← Solo si free no funciona
```

## 🔄 Flujo de Ejecución

```
1. Request llega
   ↓
2. Cargar keys del provider
   → [Free keys ordenadas por currentPriority]
   → [Paid keys ordenadas por currentPriority]
   ↓
3. Intentar con primera key free disponible
   ├─ Success ✅
   │  └─ Si estaba al final → Restaurar a originalPriority
   │
   └─ Failure ❌
      └─ Mover al final del grupo free (currentPriority = max + 1)
      ↓
4. Si todas las free fallan/rate-limited
   → Intentar con primera key paid
   ↓
5. Si todas las keys fallan
   → Error (no hay keys disponibles)
```

## 📊 Ejemplo Práctico

### Estado Inicial

```typescript
Provider: "openai"

Free Keys:
- Key1: currentPriority=1, originalPriority=1, consecutiveFailures=0
- Key2: currentPriority=2, originalPriority=2, consecutiveFailures=0
- Key3: currentPriority=3, originalPriority=3, consecutiveFailures=0

Paid Keys:
- KeyA: currentPriority=1, originalPriority=1, consecutiveFailures=0
- KeyB: currentPriority=2, originalPriority=2, consecutiveFailures=0
```

### Request 1: Key1 falla

```typescript
// Antes
Free: [Key1:p1, Key2:p2, Key3:p3]
Paid: [KeyA:p1, KeyB:p2]

// Key1 falla → Se mueve al final del grupo free
recordKeyFailure("key1_id", "rate limit exceeded")

// Después
Free: [Key2:p2, Key3:p3, Key1:p4] ← Key1 ahora prioridad 4
Paid: [KeyA:p1, KeyB:p2]          ← Sin cambios
```

### Request 2: Key2 funciona

```typescript
// Se usa Key2 (ahora primera en la cola)
// Success → Key2 mantiene su prioridad original

Free: [Key2:p2, Key3:p3, Key1:p4]
Paid: [KeyA:p1, KeyB:p2]
```

### Request 3: Key2 y Key3 fallan, Key1 funciona

```typescript
// Key2 falla → Al final
Free: [Key3:p3, Key1:p4, Key2:p5]

// Key3 falla → Al final
Free: [Key1:p4, Key2:p5, Key3:p6]

// Key1 funciona → Vuelve a originalPriority=1
Free: [Key1:p1, Key2:p5, Key3:p6]
      ↑ Restaurada a prioridad original!
```

### Request 4: Todas las free rate-limited → Se usa paid

```typescript
// Key1, Key2, Key3 todas rate-limited
// Sistema pasa automáticamente a paid keys

Free: [Key1:p1, Key2:p5, Key3:p6] (rate-limited, no disponibles)
Paid: [KeyA:p1, KeyB:p2] ← Se intenta KeyA primero
```

## 🗄️ Archivado

Una key solo se archiva después de **100 fallos TOTALES** (no consecutivos):

```typescript
Key1: totalFailures = 98  → Sigue activa, rotando
Key1: totalFailures = 99  → Sigue activa, rotando
Key1: totalFailures = 100 → ARCHIVADA ❌ (isArchived=true, isActive=false)
```

Una vez archivada, la key **nunca** se usa automáticamente. Requiere intervención manual.

## 💡 Ventajas

1. **Sin bloqueos innecesarios**: Keys siempre disponibles, solo cambian de orden
2. **Rotación natural**: Las que funcionan se usan más, las que fallan menos
3. **Recuperación automática**: Una key que vuelve a funcionar recupera su posición
4. **Priorización inteligente**: Free primero, paid solo como fallback
5. **Simple y predecible**: No hay timers, cooldowns ni estados complejos

## 🔧 Configuración

```typescript
// En ProviderKey schema
currentPriority: number     // Prioridad dinámica (cambia al fallar)
originalPriority: number    // Prioridad original (se restaura al funcionar)
isPaid: boolean             // false = grupo free, true = grupo paid
maxTotalFailures: number    // Default: 100 (para archivar)
```

## 📝 Logs

```bash
# Key falla
⬇️  Key sk-proj-... (openai) moved to last priority (5) after failure: rate limit exceeded

# Key se recupera
⬆️  Key sk-proj-... (openai) restored to priority 1 after success

# Key archivada
🗄️  Key sk-proj-... (openai) ARCHIVED after 100 total failures
```
