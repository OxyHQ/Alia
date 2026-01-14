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

import { signIn } from "next-auth/react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

export function RegisterForm({
    className,
    ...props
}: React.ComponentProps<"div">) {
    const t = useTranslations('register')
    const tCommon = useTranslations('common')
    const router = useRouter()
    const [isLoading, setIsLoading] = React.useState(false)

    async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault()
        setIsLoading(true)

        const formData = new FormData(event.currentTarget)
        const name = formData.get("name") as string
        const email = formData.get("email") as string
        const password = formData.get("password") as string
        const confirmPassword = formData.get("confirmPassword") as string

        if (password !== confirmPassword) {
            toast.error(t('passwordMismatch'))
            setIsLoading(false)
            return
        }

        try {
            const response = await fetch("/api/auth/register", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ name, email, password }),
            })

            const data = await response.json()

            if (!response.ok) {
                toast.error(data.error || t('registrationFailed'))
                return
            }

            toast.success(t('registrationSuccess'))

            // Auto sign in after registration
            const result = await signIn("credentials", {
                email,
                password,
                redirect: false,
            })

            if (result?.error) {
                router.push("/login")
            } else {
                router.push("/")
                router.refresh()
            }
        } catch (error) {
            toast.error(tCommon('errorOccurred'))
        } finally {
            setIsLoading(false)
        }
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
                        <h1 className="text-xl font-bold">{t('welcome')}</h1>
                        <FieldDescription>
                            {t('haveAccount')} <a href="/login" className="underline underline-offset-4">{t('signIn')}</a>
                        </FieldDescription>
                    </div>
                    <Field>
                        <FieldLabel htmlFor="name">{t('name')}</FieldLabel>
                        <Input
                            id="name"
                            name="name"
                            type="text"
                            placeholder={t('namePlaceholder')}
                            required
                            disabled={isLoading}
                        />
                    </Field>
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
                        <FieldLabel htmlFor="password">{t('password')}</FieldLabel>
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
                            {isLoading ? tCommon('loading') : t('register')}
                        </Button>
                    </Field>
                    <div className="relative my-4">
                        <div className="absolute inset-0 flex items-center">
                            <span className="w-full border-t" />
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-background px-2 text-muted-foreground">{tCommon('or')}</span>
                        </div>
                    </div>
                    <Field className="grid gap-4 sm:grid-cols-2">
                        <Button variant="outline" type="button" disabled={isLoading}>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                <path
                                    d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"
                                    fill="currentColor"
                                />
                            </svg>
                            {t('apple')}
                        </Button>
                        <Button variant="outline" type="button" disabled={isLoading} onClick={() => signIn('google')}>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                <path
                                    d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
                                    fill="currentColor"
                                />
                            </svg>
                            {t('google')}
                        </Button>
                    </Field>
                </FieldGroup>
            </form>
            <FieldDescription className="px-6 text-center">
                {t('termsIntro')} <a href="#">{t('termsOfService')}</a> {t('and')} <a href="#">{t('privacyPolicy')}</a>.
            </FieldDescription>
        </div>
    )
}
