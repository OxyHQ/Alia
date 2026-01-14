'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog'
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
    FieldSet,
} from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { RefreshCw, Activity, Key as KeyIcon, AlertCircle } from 'lucide-react'
import { HugeiconsIcon } from "@hugeicons/react"
import { PlusSignIcon } from "@hugeicons/core-free-icons"
import { toast } from 'sonner'
import { Toaster } from "@/components/ui/sonner"
import { UsageChart } from "@/components/usage-chart"
import { KeysTable } from "@/components/keys-table"

interface KeyData {
    provider: string
    modelId: string
    key: string
    keyMasked: string
    rpm?: number
    rpd?: number
    isPaid?: boolean
    usage?: {
        rpm: number
        rpd: number
    } | null
}

export default function AdminDashboard() {
    const [keys, setKeys] = useState<KeyData[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isAddOpen, setIsAddOpen] = useState(false)

    // New Key Form State
    const [newKey, setNewKey] = useState({
        provider: 'google',
        modelId: 'gemini-2.5-flash',
        key: '',
        rpm: '30',
        rpd: '1000',
        isPaid: false
    })

    useEffect(() => {
        // Initial fetch
        fetchKeys();

        // Conectar a SSE para Real-Time updates
        const eventSource = new EventSource('/api/admin/events');

        eventSource.onopen = () => {
            console.log('SSE Connected');
            setIsLoading(false);
        }

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                setKeys(data);
            } catch (e) {
                console.error("Error parsing SSE data", e);
            }
        };

        eventSource.onerror = (e) => {
            console.error("SSE Error", e);
            eventSource.close();
        };

        return () => {
            eventSource.close();
        };
    }, [])

    const fetchKeys = async () => {
        try {
            const res = await fetch('/api/admin/keys')
            if (res.ok) {
                const data = await res.json()
                setKeys(data)
            }
        } catch (error) {
            console.error('Error fetching keys', error)
        } finally {
            setIsLoading(false)
        }
    }

    const handleAddKey = async () => {
        try {
            const res = await fetch('/api/admin/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...newKey,
                    rpm: Number(newKey.rpm),
                    rpd: Number(newKey.rpd)
                })
            })

            if (res.ok) {
                toast.success('Key añadida correctamente')
                setIsAddOpen(false)
                fetchKeys()
                setNewKey({
                    provider: 'google',
                    modelId: 'gemini-2.5-flash',
                    key: '',
                    rpm: '30',
                    rpd: '1000',
                    isPaid: false
                })
            } else {
                const err = await res.json()
                toast.error('Error: ' + err.error)
            }
        } catch (e) {
            toast.error('Error de conexión')
        }
    }

    const handleDeleteKey = async (key: string) => {
        if (!confirm('¿Seguro que quieres eliminar esta key?')) return

        try {
            const res = await fetch('/api/admin/keys', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key })
            })

            if (res.ok) {
                toast.success('Key eliminada')
                fetchKeys()
            }
        } catch {
            toast.error('Error eliminando key')
        }
    }

    return (
        <div className="flex flex-1 flex-col gap-4 px-4 py-4 md:gap-8 md:py-8 overflow-y-auto">
            <Toaster />

            {/* Header Area */}
            <div className="flex items-center justify-between px-2">
                <div className="grid gap-1">
                    <h1 className="text-2xl font-bold tracking-tight">
                        Dashboard
                    </h1>
                    <p className="text-muted-foreground text-sm">Resumen de rendimiento y gestión de proveedores</p>
                </div>
                <div className="flex items-center gap-2">
                    <Button onClick={fetchKeys} variant="outline" size="sm" className="h-8 gap-1">
                        <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                        <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">Refrescar</span>
                    </Button>
                    <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
                        <DialogTrigger asChild>
                            <Button size="sm" className="h-8 gap-1">
                                <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="w-3.5 h-3.5" />
                                <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">Añadir Key</span>
                            </Button>
                        </DialogTrigger>
                        <DialogContent>
                            <DialogHeader>
                                <DialogTitle>Añadir Nueva API Key</DialogTitle>
                                <DialogDescription>Configura el proveedor y los límites de la key.</DialogDescription>
                            </DialogHeader>

                            <FieldSet>
                                <FieldGroup>
                                    <Field>
                                        <FieldLabel htmlFor="provider">Provider</FieldLabel>
                                        <Input
                                            id="provider"
                                            value={newKey.provider}
                                            onChange={e => setNewKey({ ...newKey, provider: e.target.value })}
                                        />
                                    </Field>
                                    <Field>
                                        <FieldLabel htmlFor="modelId">Model ID</FieldLabel>
                                        <Input
                                            id="modelId"
                                            value={newKey.modelId}
                                            onChange={e => setNewKey({ ...newKey, modelId: e.target.value })}
                                        />
                                    </Field>
                                    <Field>
                                        <FieldLabel htmlFor="key">API Key</FieldLabel>
                                        <Input
                                            id="key"
                                            value={newKey.key}
                                            onChange={e => setNewKey({ ...newKey, key: e.target.value })}
                                            placeholder="sk-..."
                                        />
                                    </Field>
                                    <Field>
                                        <FieldLabel htmlFor="rpm">Limit RPM</FieldLabel>
                                        <Input
                                            id="rpm"
                                            type="number"
                                            value={newKey.rpm}
                                            onChange={e => setNewKey({ ...newKey, rpm: e.target.value })}
                                        />
                                    </Field>
                                    <Field orientation="horizontal">
                                        <div className="flex flex-col gap-1">
                                            <FieldLabel htmlFor="isPaid">Es de Pago</FieldLabel>
                                            <FieldDescription>
                                                Marcar si esta clave pertenece a un plan de pago.
                                            </FieldDescription>
                                        </div>
                                        <Switch
                                            id="isPaid"
                                            checked={newKey.isPaid}
                                            onCheckedChange={(checked: boolean) => setNewKey({ ...newKey, isPaid: checked })}
                                        />
                                    </Field>
                                </FieldGroup>
                            </FieldSet>

                            <DialogFooter>
                                <Button onClick={handleAddKey}>Guardar</Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>
                </div>
            </div>

            {/* KPI Cards */}
            <div className="grid gap-4 md:grid-cols-3">
                <Card x-chunk="dashboard-01-chunk-0">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Keys</CardTitle>
                        <KeyIcon className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{keys.length}</div>
                        <p className="text-xs text-muted-foreground">
                            {keys.filter(k => !k.isPaid).length} Gratuitas · {keys.filter(k => k.isPaid).length} De Pago
                        </p>
                    </CardContent>
                </Card>
                <Card x-chunk="dashboard-01-chunk-1">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Uso RPM Actual</CardTitle>
                        <Activity className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {keys.reduce((acc, k) => acc + (k.usage?.rpm || 0), 0)}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Peticiones por minuto activas
                        </p>
                    </CardContent>
                </Card>
                <Card x-chunk="dashboard-01-chunk-2">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Estado Global</CardTitle>
                        <AlertCircle className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-primary">Operativo</div>
                        <p className="text-xs text-muted-foreground">
                            Todos los sistemas funcionando
                        </p>
                    </CardContent>
                </Card>
            </div>

            {/* Chart Section */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
                <div className="col-span-4">
                    <UsageChart />
                </div>
                <div className="col-span-3">
                    <Card className="h-full">
                        <CardHeader>
                            <CardTitle>Métricas del Sistema</CardTitle>
                            <CardDescription>Monitorización en tiempo real</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-6">
                                <div className="flex items-center justify-between">
                                    <div className="space-y-1">
                                        <p className="text-sm font-medium leading-none">Latencia Proxy</p>
                                        <p className="text-xs text-muted-foreground">Overhead interno</p>
                                    </div>
                                    <div className="font-mono text-sm font-bold">~12ms</div>
                                </div>
                                <div className="flex items-center justify-between">
                                    <div className="space-y-1">
                                        <p className="text-sm font-medium leading-none">Tasa de Errores</p>
                                        <p className="text-xs text-muted-foreground">Última hora</p>
                                    </div>
                                    <div className="font-mono text-sm text-green-600">0.0%</div>
                                </div>
                                <div className="flex items-center justify-between">
                                    <div className="space-y-1">
                                        <p className="text-sm font-medium leading-none">Saturación de Keys</p>
                                        <p className="text-xs text-muted-foreground">Keys al límite de RPM</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="font-mono text-sm font-bold">
                                            {keys.filter(k => k.usage && k.usage.rpm >= (k.rpm || 0)).length}
                                        </span>
                                        {keys.some(k => k.usage && k.usage.rpm >= (k.rpm || 0)) && (
                                            <span className="flex h-2 w-2 rounded-full bg-amber-500" />
                                        )}
                                    </div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>

            {/* Keys Table */}
            <div className="space-y-4">
                <div>
                    <h2 className="text-lg font-semibold tracking-tight">Gestión de API Keys</h2>
                    <p className="text-sm text-muted-foreground">Pool de claves activas y consumo en tiempo real</p>
                </div>
                <KeysTable data={keys} onDelete={handleDeleteKey} />
            </div>
        </div>
    )
}
