# Free hosting boundary

This portfolio demo targets **$0 hosting using Vercel Hobby and Neon Free**. Keep both accounts on those free plans. No paid trial, usage-based plan, custom domain, paid integration or add-on is needed. These services enforce quotas; free does not mean unlimited or guaranteed availability.

Checked against official documentation on 2026-11-01:

| Service | Free allowance relevant to this demo | At the limit |
| --- | --- | --- |
| Vercel Hobby | 4 CPU-hours, 360 GB-hours provisioned memory, 1 million function invocations, 100 GB transfer | Features generally pause until their usage window resets |
| Neon Free | 100 CU-hours/project/month, 1 GB/project storage, 5 GB/project monthly public network transfer | Compute/transfer exhaustion suspends compute; storage-growing operations fail |
| GitHub Actions | Standard hosted runners for a public repository | Subject to GitHub's free-use rules and concurrency limits |

Vercel allowances are shared by the storefront, orders project and other projects in the Hobby team. Neon also enforces a 20 GB account-wide Postgres storage cap. Limits do not trigger an automatic paid upgrade; they can make checkout unavailable. The UI must show a retryable failure and keep the cart when persistence is unavailable. [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Neon Free limits](https://neon.com/docs/introduction/plans#what-happens-if-i-exceed-my-free-plan-limits), [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

The target is a personal, noncommercial interview demo. Vercel Hobby restricts commercial use; running a real store or selling a hosted service would require a fresh hosting decision. Do not call this configuration a free commercial production service. [Vercel Hobby usage](https://vercel.com/docs/plans/hobby).

Use Vercel `iad1` and a nearby Neon region. Neon Free suspends an idle compute after five minutes, so the first checkout after inactivity can take longer. Its free recovery history is short and it has no uptime SLA; this demo makes no guaranteed recovery or availability promise. [Neon plans](https://neon.com/docs/introduction/plans).

Quotes expire after 15 minutes and resolved receipts normally after 30 days. Unresolved Stripe pending/review records are retained until resolved, so they can grow storage beyond that window and need investigation. A daily authenticated cleanup removes eligible expired rows; application checks enforce resolved-receipt expiry even if cleanup is delayed. No keep-alive pings or synthetic traffic loops are configured. Vercel Hobby cron runs daily within the selected hour and is best effort. Monitor failures before claiming a retention deadline has been met. [Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Cron behavior](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

Optional Stripe sandbox checkout uses test keys and test payment details; test transactions do not move funds. No live payment processing is enabled, and no paid Stripe add-on is required by this implementation. This is not a quote for live processing fees. [Stripe testing](https://docs.stripe.com/testing).

Before changing plans or enabling anything billed separately, recheck pricing and obtain approval. There are no account-owned AWS resources, AWS credentials or AWS deployment steps in this design.
