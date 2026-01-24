# ActivityPub Server para @alia@alia.onl

Implementación completa de servidor ActivityPub que permite a Alia funcionar en el Fediverso.

## 🚀 Quick Start

### 1. Generar Claves RSA

```bash
cd apps/api
npm run generate-keys
```

### 2. Configurar Variables de Entorno

**apps/api/.env**:
```env
ACTIVITYPUB_DOMAIN=alia.onl
ACTOR_DOMAIN=api.alia.onl
MONGODB_URI=mongodb+srv://...
```

### 3. Deploy

Push a tu repo de Git. DigitalOcean auto-deploya.

## 📁 Estructura

```
apps/api/src/
├── lib/activitypub/         # Lógica core
│   ├── config.ts            # Configuración
│   ├── signatures.ts        # Firmas HTTP RSA
│   ├── fetcher.ts           # Fetch actores remotos
│   ├── sender.ts            # Envío de actividades
│   ├── processor.ts         # Procesar menciones
│   └── utils.ts             # Utilidades
├── routes/activitypub/      # Endpoints HTTP
│   ├── actor.ts             # GET /actors/alia
│   ├── inbox.ts             # POST /actors/alia/inbox
│   ├── outbox.ts            # GET /actors/alia/outbox
│   └── followers.ts         # GET /actors/alia/followers
└── models/activitypub-*.ts  # MongoDB models

apps/app/
├── app/api/.well-known/webfinger/+api.ts  # API route
└── public/.well-known/webfinger           # Fallback estático
```

## 🧪 Testing

```bash
# WebFinger
curl https://alia.onl/.well-known/webfinger?resource=acct:alia@alia.onl

# Actor
curl -H "Accept: application/activity+json" https://api.alia.onl/actors/alia

# Health
curl https://api.alia.onl/activitypub/health
```

Luego desde Mastodon: busca `@alia@alia.onl` y menciónalo.

## 📖 Documentación Completa

Ver [IMPLEMENTACION_COMPLETA.md](IMPLEMENTACION_COMPLETA.md) para guía detallada.

## ✅ Checklist de Deploy

- [ ] Claves RSA generadas
- [ ] Variables de entorno configuradas
- [ ] WebFinger funciona en alia.onl
- [ ] Actor endpoint retorna JSON válido
- [ ] Buscar @alia@alia.onl desde Mastodon funciona
- [ ] Menciones generan respuestas

## 🐛 Troubleshooting

**No se encuentra @alia@alia.onl**
→ Verifica WebFinger en alia.onl

**Invalid signature**
→ Regenera claves RSA

**No responde menciones**
→ Revisa logs en DigitalOcean

---

**Handle**: `@alia@alia.onl`
**Modelo**: alia-lite (Gemini Flash)
**Límite**: 480 caracteres por respuesta
