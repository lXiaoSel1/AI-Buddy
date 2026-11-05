# AI Buddy 2.0.4

This host adds the table service and local wallet support for Card Games. Install the separately versioned Card Games 1.0.0 plugin from the official Extension Center catalog. It includes Dou Dizhu and Texas Hold'em, dealing and board animations, a post-hand reveal for Dou Dizhu, and pausing and resuming saved tables. Tests with synthetic model responses cover the game flow. Live model play and response quality remain unverified.

- The 30fps and 60fps editions share the same features and reuse the 2.0.3 animation assets.
- Bilibili Companion 2.0.11 and QQ Connect 2.0.6 retain their versions.
- The host and plugin are source-available under Apache-2.0 with the Commons Clause. See each project's third-party notices for asset and dependency terms.

## Upgrades and rollback

The first launch with an existing save upgrades the wallet from schema 1 to schema 2. Back up the save before upgrading. AI Buddy 2.0.3 cannot write a schema 2 wallet, and switching the program pointer leaves the migration intact. If the new program may already have migrated the wallet, the installer retains both builds and the save so you can repair with the 2.0.4 installer. To run 2.0.3 again, open a separate copy of the pre-upgrade backup and keep the migrated save.
