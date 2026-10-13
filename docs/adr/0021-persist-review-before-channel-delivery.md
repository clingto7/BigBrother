# ADR 0021: Persist one review record before channel delivery

Status: Accepted for the next design

Big Brother stores the complete Review record as the common source for the
Operator session and every enabled delivery channel. A GitHub Commit Status
or an external message carries a concise presentation of that record. Each
channel has independent durable delivery state and retries; a failed Feishu,
Bark, or RSS delivery does not rerun the review or change its conclusion.
This separates the cost and correctness of review from the availability of
external services and permits later inspection or redelivery of the same
evidence-backed result.

The first delivery set is the local Review record, GitHub Commit Status, and
optional Bark push notifications. Feishu, WeChat, and RSS remain later channel
choices.
