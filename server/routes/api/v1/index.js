/**
 * /api/v1: federation API for sister TraceApps and other authorized
 * integrations. Bearer-token auth, per-token rate limit, scope-gated
 * endpoints. Currently the sole consumer is NutriTrace, which pulls
 * CookTrace recipes into its meals catalog via the read:recipes scope.
 * See docs/cooktrace/nt-federation.md for the wire contract.
 */
import { Router } from 'express';
import { bearerAuth } from '../../../middleware/bearer-auth.js';
import meRouter from './me.js';
import recipesRouter from './recipes.js';
import pantryRouter from './pantry.js';
import pantryWriteRouter from './pantry-write.js';
import cookDiaryRouter from './cook-diary.js';
import shoppingRouter from './shopping.js';

const router = Router();

router.use(bearerAuth);

router.use('/me', meRouter);
router.use('/recipes', recipesRouter);
router.use('/pantry', pantryRouter);
// cook-diary/shopping/pantry-write are the general-purpose public API (a
// user's own scripts and automations), not a sister-app federation
// contract like the routers above. Each self-gates behind
// PUBLIC_API_ENABLED and reuses the mcp:read/mcp:write scopes MCP
// already defines. pantry-write shares the '/pantry' prefix with the
// read-only federation router above; Express tries routers in mount
// order, so a GET still resolves in pantry.js and a PATCH falls
// through to pantry-write.js.
router.use('/pantry', pantryWriteRouter);
router.use('/cook-diary', cookDiaryRouter);
router.use('/shopping', shoppingRouter);

export default router;
