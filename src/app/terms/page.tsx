import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service - Alia",
  description: "Terms of Service for Alia AI Agent Platform",
};

export default function TermsOfServicePage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-start bg-background p-6 md:p-10">
      <div className="w-full max-w-4xl">
        <div className="space-y-8">
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight">Terms of Service</h1>
            <p className="text-muted-foreground">Last updated: {new Date().toLocaleDateString()}</p>
          </div>

          <div className="prose prose-neutral dark:prose-invert max-w-none">
            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">1. Acceptance of Terms</h2>
              <p className="text-muted-foreground">
                By accessing and using Alia (&quot;the Service&quot;), you accept and agree to be bound by the terms
                and provision of this agreement. If you do not agree to abide by the above, please do not use this service.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">2. Use License</h2>
              <p className="text-muted-foreground">
                Permission is granted to temporarily access and use the Service for personal, non-commercial purposes.
                This is the grant of a license, not a transfer of title, and under this license you may not:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-4">
                <li>Modify or copy the materials</li>
                <li>Use the materials for any commercial purpose or for any public display</li>
                <li>Attempt to reverse engineer any software contained in the Service</li>
                <li>Remove any copyright or other proprietary notations from the materials</li>
                <li>Transfer the materials to another person or &quot;mirror&quot; the materials on any other server</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">3. Account Terms</h2>
              <p className="text-muted-foreground">
                You must be 13 years or older to use this Service. You are responsible for maintaining the security of
                your account and password. Alia cannot and will not be liable for any loss or damage from your failure
                to comply with this security obligation.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">4. API Usage</h2>
              <p className="text-muted-foreground">
                Users are granted access to our AI agent API platform. You agree to:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-4">
                <li>Use the API in accordance with our usage policies and rate limits</li>
                <li>Not attempt to circumvent usage limitations or authentication mechanisms</li>
                <li>Not use the service for any illegal or unauthorized purpose</li>
                <li>Not introduce viruses, malicious code, or any harmful components</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">5. Payment and Billing</h2>
              <p className="text-muted-foreground">
                Certain features of the Service may require payment. You agree to provide current, complete, and accurate
                purchase and account information. You agree to promptly update your account and payment information as needed.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">6. Intellectual Property</h2>
              <p className="text-muted-foreground">
                The Service and its original content, features, and functionality are owned by Alia and are protected by
                international copyright, trademark, patent, trade secret, and other intellectual property laws.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">7. User Content</h2>
              <p className="text-muted-foreground">
                You retain all rights to any content you submit, post, or display on or through the Service. By submitting
                content, you grant us a worldwide, non-exclusive, royalty-free license to use, copy, reproduce, process,
                adapt, publish, and display such content for the purposes of operating and providing the Service.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">8. Prohibited Uses</h2>
              <p className="text-muted-foreground">
                You may not use the Service:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-4">
                <li>In any way that violates any applicable national or international law or regulation</li>
                <li>To exploit, harm, or attempt to exploit or harm minors in any way</li>
                <li>To transmit any unsolicited advertising or promotional material</li>
                <li>To impersonate or attempt to impersonate the Company, its employees, or other users</li>
                <li>To engage in any conduct that restricts or inhibits anyone&apos;s use of the Service</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">9. Termination</h2>
              <p className="text-muted-foreground">
                We may terminate or suspend your account and bar access to the Service immediately, without prior notice
                or liability, under our sole discretion, for any reason whatsoever, including without limitation if you
                breach the Terms.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">10. Limitation of Liability</h2>
              <p className="text-muted-foreground">
                In no event shall Alia, nor its directors, employees, partners, agents, suppliers, or affiliates, be
                liable for any indirect, incidental, special, consequential, or punitive damages, including without
                limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from your access
                to or use of or inability to access or use the Service.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">11. Disclaimer</h2>
              <p className="text-muted-foreground">
                The Service is provided on an &quot;AS IS&quot; and &quot;AS AVAILABLE&quot; basis. The Service is provided without
                warranties of any kind, whether express or implied, including, but not limited to, implied warranties of
                merchantability, fitness for a particular purpose, non-infringement, or course of performance.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">12. Changes to Terms</h2>
              <p className="text-muted-foreground">
                We reserve the right, at our sole discretion, to modify or replace these Terms at any time. If a revision
                is material, we will provide at least 30 days&apos; notice prior to any new terms taking effect. What constitutes
                a material change will be determined at our sole discretion.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">13. Contact Information</h2>
              <p className="text-muted-foreground">
                If you have any questions about these Terms, please contact us at support@alia.ai
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
