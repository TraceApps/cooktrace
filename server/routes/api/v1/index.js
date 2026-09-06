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

const router = Router();

router.use(bearerAuth);

router.use('/me', meRouter);
router.use('/recipes', recipesRouter);

export default router;
