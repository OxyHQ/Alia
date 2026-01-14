"use client"

import * as React from "react"
import {
    BadgeCheck,
    Bell,
    CreditCard,
    User,
    Settings,
    Shield,
    Smartphone,
} from "lucide-react"
import { useTranslations } from 'next-intl'

import {
    Dialog,
    DialogContent,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

type Section = "account" | "billing" | "notifications" | "security" | "devices"

interface SettingsDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    initialSection?: Section
}

export function SettingsDialog({ open, onOpenChange, initialSection = "account" }: SettingsDialogProps) {
    const [activeSection, setActiveSection] = React.useState<Section>(initialSection)
    const t = useTranslations('settings')

    React.useEffect(() => {
        if (open) {
            setActiveSection(initialSection)
        }
    }, [open, initialSection])

    const menuItems = [
        { id: "account", label: t('sections.account'), icon: User },
        { id: "billing", label: t('sections.billing'), icon: CreditCard },
        { id: "notifications", label: t('sections.notifications'), icon: Bell },
        { id: "security", label: t('sections.security'), icon: Shield },
        { id: "devices", label: t('sections.devices'), icon: Smartphone },
    ]

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-[95vw] md:max-w-5xl p-0 overflow-hidden h-[90vh] md:h-[700px] flex flex-col md:flex-row gap-0">
                <DialogTitle className="sr-only">{t('title')}</DialogTitle>
                <DialogDescription className="sr-only">{t('description')}</DialogDescription>

                {/* Sidebar */}
                <div className="w-full md:w-64 border-b md:border-b-0 md:border-r bg-muted/20 p-4 flex flex-row md:flex-col gap-2 md:gap-1 overflow-x-auto md:overflow-x-visible shrink-0">
                    <div className="hidden md:block px-2 py-2 mb-2">
                        <h2 className="text-lg font-semibold tracking-tight">{t('settingsTitle')}</h2>
                    </div>
                    {menuItems.map((item) => (
                        <button
                            key={item.id}
                            onClick={() => setActiveSection(item.id as Section)}
                            className={cn(
                                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                                activeSection === item.id
                                    ? "bg-primary text-primary-foreground"
                                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            )}
                        >
                            <item.icon className="size-4" />
                            {item.label}
                        </button>
                    ))}
                    <div className="hidden md:block mt-auto pt-4">
                        <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            {t('info')}
                        </div>
                        <div className="px-3 py-1 text-xs text-muted-foreground">
                            {t('version')}
                        </div>
                    </div>
                </div>

                {/* Content Area */}
                <div className="flex-1 p-6 md:p-10 overflow-y-auto">
                    {activeSection === "account" && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-right-2 duration-300">
                            <div>
                                <h3 className="text-xl font-bold">{t('account.title')}</h3>
                                <p className="text-sm text-muted-foreground">{t('account.description')}</p>
                            </div>
                            <Separator />
                            <div className="space-y-4">
                                <div className="grid gap-2">
                                    <label className="text-sm font-medium">{t('account.name')}</label>
                                    <input className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50" defaultValue={t('account.nameDefault')} />
                                </div>
                                <div className="grid gap-2">
                                    <label className="text-sm font-medium">{t('account.email')}</label>
                                    <input className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50" defaultValue="user@alia.onl" />
                                </div>
                                <Button className="mt-2">{t('account.saveChanges')}</Button>
                            </div>
                        </div>
                    )}

                    {activeSection === "billing" && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-right-2 duration-300">
                            <div>
                                <h3 className="text-xl font-bold">{t('billing.title')}</h3>
                                <p className="text-sm text-muted-foreground">{t('billing.description')}</p>
                            </div>
                            <Separator />
                            <div className="rounded-xl border p-6 bg-muted/10 space-y-4">
                                <div className="flex justify-between items-start">
                                    <div>
                                        <p className="text-sm font-medium text-muted-foreground">{t('billing.currentPlan')}</p>
                                        <h4 className="text-2xl font-bold">{t('billing.aliaPro')}</h4>
                                    </div>
                                    <BadgeCheck className="text-primary size-6" />
                                </div>
                                <p className="text-sm">{t('billing.nextPayment')} <span className="font-bold">$20.00</span> {t('billing.willBeOn')}</p>
                                <div className="flex gap-2">
                                    <Button variant="outline" size="sm">{t('billing.manageSubscription')}</Button>
                                    <Button variant="ghost" size="sm">{t('billing.viewInvoices')}</Button>
                                </div>
                            </div>
                            <div className="space-y-4">
                                <h4 className="text-sm font-semibold">{t('billing.paymentMethods')}</h4>
                                <div className="flex items-center justify-between p-4 border rounded-lg">
                                    <div className="flex items-center gap-3">
                                        <div className="bg-muted size-10 rounded flex items-center justify-center">
                                            <CreditCard className="size-5" />
                                        </div>
                                        <div>
                                            <p className="text-sm font-medium">{t('billing.visaEnding')} 4242</p>
                                            <p className="text-xs text-muted-foreground">{t('billing.expires')} 12/28</p>
                                        </div>
                                    </div>
                                    <Button variant="ghost" size="sm">Edit</Button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Placeholder content for other sections */}
                    {(activeSection === "notifications" || activeSection === "security" || activeSection === "devices") && (
                        <div className="flex flex-col items-center justify-center h-full text-center space-y-4 animate-in fade-in duration-300">
                            <Settings className="size-12 text-muted-foreground opacity-20" />
                            <h3 className="text-lg font-medium capitalize">{activeSection}</h3>
                            <p className="text-sm text-muted-foreground">{t('placeholder.underConstruction')}</p>
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}
