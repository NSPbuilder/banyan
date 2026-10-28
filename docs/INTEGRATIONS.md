# Integrations and data boundaries

Banyan can operate with its database and local document storage. The following services are optional. See [.env.example](../.env.example) for the actual configuration names; never commit live settings.

| Integration | Configuration and boundary |
|---|---|
| AI assistance | Configure supported model services and credentials in protected settings; `AI_KEY_SECRET` encrypts configured keys. Selected documents and prompts can be sent to the provider. |
| MCP | `MCP_ENABLED=false` and `MCP_WRITES_ENABLED=false` by default. Set an HTTPS `MCP_PUBLIC_ORIGIN`, create user/ledger-scoped credentials and grant only needed tools. Draft proposals require explicit scopes and browser confirmation before accounting changes. |
| Passkeys | Off by default. Choose `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` for the permanent deployment before enabling; changing these later affects credential usability. |
| SMTP / automation | Configure SMTP with remote TLS and explicitly enable/schedule automation. The worker requires `DATABASE_URL` and `--database` with the exact target name. Keep `SMTP_LOCAL_CAPTURE=false` outside loopback test capture. |
| Payments / inbound messages | Off by default (`ONLINE_PAYMENTS_ENABLED`, `INBOUND_MAIL_ENABLED`). Configure `INTEGRATION_KEY_SECRET`, HTTPS `P5_PUBLIC_ORIGIN` and company-specific provider settings. Provider verification and ingress restrictions still apply. This is not a personal Outlook mailbox module. |
| Documenso | Optional cloud e-sign workflow configured through the application's protected service settings; documents are processed by that external service. |
| Bank of Canada rates | Public Valet exchange-rate data is used for supported FX workflows. Source/rate evidence is retained. External service availability and data terms apply. |

For Postmark inbound webhooks, set `POSTMARK_INGRESS_IP_FILTER_CONFIGURED=true` only after the network actually restricts the route to published provider IPs. A flag is not a firewall. For all public provider routes, enforce the application's documented HTTPS/proxy checks and protect direct access to the internal port.

The application being self-hosted does not make configured third-party processing local. Review what company data each enabled feature sends and retain a recovery copy of encryption secrets. No provider account, API key, hosted-service entitlement or external service is included in the source package.
