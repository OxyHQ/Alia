'use client'

import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

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

interface KeysTableProps {
    data: KeyData[]
    onDelete: (key: string) => void
}

export function KeysTable({ data, onDelete }: KeysTableProps) {
    const t = useTranslations('admin.table')
    const tAdmin = useTranslations('admin.dashboard')

    return (
        <div className="rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>{t('provider')}</TableHead>
                        <TableHead>{t('model')}</TableHead>
                        <TableHead>{t('keyMasked')}</TableHead>
                        <TableHead>{t('tier')}</TableHead>
                        <TableHead>{t('usageMinute')}</TableHead>
                        <TableHead className="text-right">{t('actions')}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {data.map((key) => (
                        <TableRow key={key.key}>
                            <TableCell>
                                <Badge variant="outline" className="capitalize">
                                    {key.provider}
                                </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs">{key.modelId}</TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">{key.keyMasked}</TableCell>
                            <TableCell>
                                {key.isPaid ?
                                    <Badge variant="secondary">{tAdmin('paid').toUpperCase()}</Badge> :
                                    <Badge variant="outline">{tAdmin('free').toUpperCase()}</Badge>}
                            </TableCell>
                            <TableCell>
                                <div className="space-y-1">
                                    <div className="flex items-center justify-between text-xs">
                                        <span className="text-muted-foreground">{t('reqs')}:</span>
                                        <span className={key.usage?.rpm && key.rpm && key.usage.rpm >= key.rpm ? 'text-destructive font-bold' : ''}>
                                            {key.usage?.rpm || 0} / {key.rpm || '∞'}
                                        </span>
                                    </div>
                                    <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-primary transition-all duration-500"
                                            style={{ width: `${Math.min(100, ((key.usage?.rpm || 0) / (key.rpm || 1)) * 100)}%` }}
                                        />
                                    </div>
                                </div>
                            </TableCell>
                            <TableCell className="text-right">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => onDelete(key.key)}
                                >
                                    <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                                </Button>
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    )
}
