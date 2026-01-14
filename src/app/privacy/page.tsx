import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy - Alia",
  description: "Privacy Policy for Alia AI Agent Platform",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-start bg-background p-6 md:p-10">
      <div className="w-full max-w-4xl">
        <div className="space-y-8">
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight">Privacy Policy</h1>
            <p className="text-muted-foreground">Last updated: {new Date().toLocaleDateString()}</p>
          </div>

          <div className="prose prose-neutral dark:prose-invert max-w-none">
            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">1. Introduction</h2>
              <p className="text-muted-foreground">
                Welcome to Alia (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;). We are committed to protecting your personal
                information and your right to privacy. This Privacy Policy explains how we collect, use, disclose, and
                safeguard your information when you use our AI agent platform service.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">2. Information We Collect</h2>
              <p className="text-muted-foreground">
                We collect information that you provide directly to us, including:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-4">
                <li><strong>Account Information:</strong> Name, email address, password, and other registration details</li>
                <li><strong>Profile Information:</strong> Preferences, settings, and customization choices</li>
                <li><strong>Payment Information:</strong> Billing address and payment method details (processed securely through third-party payment processors)</li>
                <li><strong>Usage Data:</strong> API calls, prompts, responses, and interaction history with our AI agents</li>
                <li><strong>Technical Information:</strong> IP address, browser type, device information, and operating system</li>
                <li><strong>Communications:</strong> Messages, feedback, and support requests you send to us</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">3. How We Use Your Information</h2>
              <p className="text-muted-foreground">
                We use the information we collect to:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-4">
                <li>Provide, maintain, and improve our services</li>
                <li>Process your transactions and manage your account</li>
                <li>Send you technical notices, updates, and support messages</li>
                <li>Respond to your comments, questions, and customer service requests</li>
                <li>Monitor and analyze trends, usage, and activities in connection with our services</li>
                <li>Detect, prevent, and address technical issues and security threats</li>
                <li>Personalize and improve your experience with our AI agents</li>
                <li>Comply with legal obligations and enforce our terms and policies</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">4. Data Retention</h2>
              <p className="text-muted-foreground">
                We retain your personal information for as long as necessary to provide you with our services and as
                described in this Privacy Policy. We will retain and use your information to the extent necessary to
                comply with our legal obligations, resolve disputes, and enforce our agreements.
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-4">
                <li><strong>Account Data:</strong> Retained while your account is active and for a reasonable period thereafter</li>
                <li><strong>Usage Data:</strong> May be retained for analytical purposes, typically up to 90 days</li>
                <li><strong>Conversation History:</strong> Stored according to your retention preferences or until deletion</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">5. Information Sharing and Disclosure</h2>
              <p className="text-muted-foreground">
                We do not sell your personal information. We may share your information in the following circumstances:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-4">
                <li><strong>Service Providers:</strong> Third-party vendors who perform services on our behalf (hosting, payment processing, analytics)</li>
                <li><strong>Legal Requirements:</strong> When required by law, subpoena, or legal process</li>
                <li><strong>Business Transfers:</strong> In connection with a merger, acquisition, or sale of assets</li>
                <li><strong>With Your Consent:</strong> When you explicitly agree to share your information</li>
                <li><strong>AI Model Providers:</strong> Necessary data shared with AI model providers to deliver agent services (subject to strict data processing agreements)</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">6. Data Security</h2>
              <p className="text-muted-foreground">
                We implement appropriate technical and organizational measures to protect your personal information against
                unauthorized access, alteration, disclosure, or destruction. These measures include:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-4">
                <li>Encryption of data in transit and at rest</li>
                <li>Regular security assessments and updates</li>
                <li>Access controls and authentication mechanisms</li>
                <li>Secure API key management</li>
                <li>Regular backups and disaster recovery procedures</li>
              </ul>
              <p className="text-muted-foreground mt-4">
                However, no method of transmission over the Internet or electronic storage is 100% secure. While we
                strive to use commercially acceptable means to protect your information, we cannot guarantee absolute security.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">7. Your Privacy Rights</h2>
              <p className="text-muted-foreground">
                Depending on your location, you may have the following rights regarding your personal information:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-4">
                <li><strong>Access:</strong> Request access to your personal information</li>
                <li><strong>Correction:</strong> Request correction of inaccurate or incomplete information</li>
                <li><strong>Deletion:</strong> Request deletion of your personal information</li>
                <li><strong>Data Portability:</strong> Request a copy of your data in a structured, machine-readable format</li>
                <li><strong>Opt-out:</strong> Opt-out of certain data processing activities</li>
                <li><strong>Withdraw Consent:</strong> Withdraw consent where processing is based on consent</li>
              </ul>
              <p className="text-muted-foreground mt-4">
                To exercise these rights, please contact us at privacy@alia.ai
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">8. Cookies and Tracking Technologies</h2>
              <p className="text-muted-foreground">
                We use cookies and similar tracking technologies to track activity on our service and hold certain information.
                Cookies are files with a small amount of data which may include an anonymous unique identifier.
              </p>
              <p className="text-muted-foreground">
                You can instruct your browser to refuse all cookies or to indicate when a cookie is being sent. However,
                if you do not accept cookies, you may not be able to use some portions of our service.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">9. Third-Party Services</h2>
              <p className="text-muted-foreground">
                Our service may contain links to third-party websites or services that are not owned or controlled by us.
                We have no control over and assume no responsibility for the content, privacy policies, or practices of
                any third-party websites or services.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">10. Children&apos;s Privacy</h2>
              <p className="text-muted-foreground">
                Our service is not intended for use by children under the age of 13. We do not knowingly collect personally
                identifiable information from children under 13. If you are a parent or guardian and you are aware that
                your child has provided us with personal information, please contact us.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">11. International Data Transfers</h2>
              <p className="text-muted-foreground">
                Your information may be transferred to and maintained on computers located outside of your state, province,
                country, or other governmental jurisdiction where data protection laws may differ. We will take all steps
                reasonably necessary to ensure that your data is treated securely and in accordance with this Privacy Policy.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">12. California Privacy Rights</h2>
              <p className="text-muted-foreground">
                If you are a California resident, you have specific rights regarding your personal information under the
                California Consumer Privacy Act (CCPA). This includes the right to know what personal information we collect,
                the right to delete personal information, and the right to opt-out of the sale of personal information.
                We do not sell personal information.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">13. GDPR Compliance</h2>
              <p className="text-muted-foreground">
                If you are a resident of the European Economic Area (EEA), you have certain data protection rights under
                the General Data Protection Regulation (GDPR). We process your personal data based on the following legal
                grounds: consent, contract performance, legal obligations, and legitimate interests.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">14. Changes to This Privacy Policy</h2>
              <p className="text-muted-foreground">
                We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new
                Privacy Policy on this page and updating the &quot;Last updated&quot; date. You are advised to review this Privacy
                Policy periodically for any changes.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold">15. Contact Us</h2>
              <p className="text-muted-foreground">
                If you have any questions about this Privacy Policy, please contact us:
              </p>
              <ul className="list-none space-y-2 text-muted-foreground ml-4">
                <li>Email: privacy@alia.ai</li>
                <li>Support: support@alia.ai</li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
