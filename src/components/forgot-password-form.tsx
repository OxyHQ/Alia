"use client"

import * as React from "react"
import { useTranslations } from 'next-intl'

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

export function ForgotPasswordForm({
    className,
    ...props
}: React.ComponentProps<"div">) {
    const t = useTranslations('forgotPassword')
    const tCommon = useTranslations('common')
    const [isLoading, setIsLoading] = React.useState(false)
    const [submitted, setSubmitted] = React.useState(false)

    async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault()
        setIsLoading(true)

        const formData = new FormData(event.currentTarget)
        const email = formData.get("email") as string

        try {
            const response = await fetch("/api/auth/forgot-password", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ email }),
            })

            const data = await response.json()

            if (!response.ok) {
                toast.error(data.error || t('requestFailed'))
                return
            }

            setSubmitted(true)
            toast.success(t('requestSuccess'))

            // Log the reset URL in development
            if (data.resetUrl && process.env.NODE_ENV === 'development') {
                console.log('Password reset URL:', data.resetUrl)
            }
        } catch (error) {
            toast.error(tCommon('errorOccurred'))
        } finally {
            setIsLoading(false)
        }
    }

    if (submitted) {
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
                    <h1 className="text-xl font-bold">{t('checkEmail')}</h1>
                    <FieldDescription>
                        {t('checkEmailDescription')}
                    </FieldDescription>
                </div>
                <Button asChild>
                    <a href="/login">{t('backToLogin')}</a>
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
                        <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
                        <Input
                            id="email"
                            name="email"
                            type="email"
                            placeholder="m@example.com"
                            required
                            disabled={isLoading}
                        />
                    </Field>
                    <Field>
                        <Button type="submit" className="w-full" disabled={isLoading}>
                            {isLoading ? tCommon('loading') : t('sendResetLink')}
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
