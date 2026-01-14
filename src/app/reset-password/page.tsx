import { ResetPasswordForm } from "@/components/reset-password-form"
import { Suspense } from "react"

function ResetPasswordContent() {
    return <ResetPasswordForm />
}

export default function ResetPasswordPage() {
    return (
        <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
            <div className="flex w-full max-w-sm flex-col gap-6">
                <Suspense fallback={<div>Loading...</div>}>
                    <ResetPasswordContent />
                </Suspense>
            </div>
        </div>
    )
}
