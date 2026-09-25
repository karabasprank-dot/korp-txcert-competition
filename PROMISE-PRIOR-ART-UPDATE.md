# Promise Receipt: expanded prior-art check

September 25, 2026. This updates the earlier bounded search; do not claim first implementation or treat nonce-based payment commitments as new.

- Roundhouse KYA publicly documents signing a statement and placing the signed-document digest in the EIP-3009 authorization nonce, anchoring the commitment with the payment. Its page exposes signing/verification UI and HTTP routes. We reviewed the documentation, not a live settlement: https://roundhouseai.io/kya
- Warrant SDK 0.1.1 explicitly binds warrant terms, including conditionHash and actionHash, into an EIP-3009 nonce. Its PyPI release is dated August 10, 2026; 0.1.0 is dated August 7 and also describes this terms binding. This is direct earlier published overlap with the broad payment-commits-to-terms idea: https://pypi.org/project/warrant-sdk/0.1.1/ and https://pypi.org/project/warrant-sdk/0.1.0/
- Verifiable Invoice Commitment publishes a reference implementation and specifies that invoiceHash may serve as the EIP-3009 nonce. This particular composition is documented as optional; we did not execute its nonce path: https://github.com/javierpmateos/verifiable-invoice-commitment

The reviewed material does not establish an exact equivalent of Korp's full merchant-acceptance-signature commitment plus merchant-signed salted response tree and selective equality-violation witness. That remaining distinction is a research question, not proof of invention, exclusivity, patentability or priority. GitHub publication records our implementation; it does not establish that we were first.

No deployed assets or public GitHub files were changed during this question-and-answer research check. This local note prevents reuse of the earlier incomplete search conclusion.
