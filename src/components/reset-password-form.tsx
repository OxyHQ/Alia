"use client"

import * as React from "react"
import { useTranslations } from 'next-intl'
import { useSearchParams, useRouter } from 'next/navigation'

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"

export function ResetPasswordForm({
    className,
    ...props
}: React.ComponentProps<"div">) {
    const t = useTranslations('resetPassword')
    const tCommon = useTranslations('common')
    const router = useRouter()
    const searchParams = useSearchParams()
    const token = searchParams.get('token')
    const [isLoading, setIsLoading] = React.useState(false)

    async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault()
        setIsLoading(true)

        const formData = new FormData(event.currentTarget)
        const password = formData.get("password") as string
        const confirmPassword = formData.get("confirmPassword") as string

        if (password !== confirmPassword) {
            toast.error(t('passwordMismatch'))
            setIsLoading(false)
            return
        }

        if (!token) {
            toast.error(t('invalidToken'))
            setIsLoading(false)
            return
        }

        try {
            const response = await fetch("/api/auth/reset-password", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ token, password }),
            })

            const data = await response.json()

            if (!response.ok) {
                toast.error(data.error || t('resetFailed'))
                return
            }

            toast.success(t('resetSuccess'))

            // Redirect to login page after 2 seconds
            setTimeout(() => {
                router.push('/login')
            }, 2000)
        } catch (error) {
            toast.error(tCommon('errorOccurred'))
        } finally {
            setIsLoading(false)
        }
    }

    if (!token) {
        return (
            <div className={cn("flex flex-col gap-6", className)} {...props}>
                <div className="flex flex-col items-center gap-2 text-center">
                    <a
                        href="/"
                        className="flex flex-col items-center gap-2 font-medium"
                    >
                        <div className="flex size-8 items-center justify-center squircle overflow-hidden">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src="/icon-512-maskable.png" alt="Alia" className="size-full object-cover" />
                        </div>
                        <span className="sr-only">Alia</span>
                    </a>
                    <h1 className="text-xl font-bold">{t('invalidToken')}</h1>
                    <FieldDescription>
                        {t('invalidTokenDescription')}
                    </FieldDescription>
                </div>
                <Button asChild>
                    <a href="/forgot-password">{t('requestNewLink')}</a>
                </Button>
            </div>
        )
    }

    return (
        <div className={cn("flex flex-col gap-6", className)} {...props}>
            <form onSubmit={onSubmit}>
                <FieldGroup>
                    <div className="flex flex-col items-center gap-2 text-center">
                        <a
                            href="/"
                            className="flex flex-col items-center gap-2 font-medium"
                        >
                            <div className="flex size-8 items-center justify-center squircle overflow-hidden">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src="/icon-512-maskable.png" alt="Alia" className="size-full object-cover" />
                            </div>
                            <span className="sr-only">Alia</span>
                        </a>
                        <h1 className="text-xl font-bold">{t('title')}</h1>
                        <FieldDescription>
                            {t('description')}
                        </FieldDescription>
                    </div>
                    <Field>
                        <FieldLabel htmlFor="password">{t('newPassword')}</FieldLabel>
                        <Input
                            id="password"
                            name="password"
                            type="password"
                            required
                            disabled={isLoading}
                            minLength={6}
                        />
                    </Field>
                    <Field>
                        <FieldLabel htmlFor="confirmPassword">{t('confirmPassword')}</FieldLabel>
                        <Input
                            id="confirmPassword"
                            name="confirmPassword"
                            type="password"
                            required
                            disabled={isLoading}
                            minLength={6}
                        />
                    </Field>
                    <Field>
                        <Button type="submit" className="w-full" disabled={isLoading}>
                            {isLoading ? tCommon('loading') : t('resetPassword')}
                        </Button>
                    </Field>
                </FieldGroup>
            </form>
            <FieldDescription className="text-center">
                <a href="/login" className="underline underline-offset-4">{t('backToLogin')}</a>
            </FieldDescription>
        </div>
    )
}
