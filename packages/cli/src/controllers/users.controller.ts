import type { FindManyOptions } from 'typeorm';
import { In, Not } from 'typeorm';
import { User } from '@db/entities/User';
import { SharedCredentials } from '@db/entities/SharedCredentials';
import { SharedWorkflow } from '@db/entities/SharedWorkflow';
import { RequireGlobalScope, Authorized, Delete, Get, RestController, Patch } from '@/decorators';
import { ListQuery, UserRequest, UserSettingsUpdatePayload } from '@/requests';
import { ActiveWorkflowRunner } from '@/ActiveWorkflowRunner';
import { IExternalHooksClass, IInternalHooksClass } from '@/Interfaces';
import type { PublicUser, ITelemetryUserDeletionData } from '@/Interfaces';
import { AuthIdentity } from '@db/entities/AuthIdentity';
import { SharedCredentialsRepository } from '@db/repositories/sharedCredentials.repository';
import { SharedWorkflowRepository } from '@db/repositories/sharedWorkflow.repository';
import { plainToInstance } from 'class-transformer';
import { RoleService } from '@/services/role.service';
import { UserService } from '@/services/user.service';
import { listQueryMiddleware } from '@/middlewares';
import { Logger } from '@/Logger';
import { UnauthorizedError } from '@/errors/response-errors/unauthorized.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';

@Authorized()
@RestController('/users')
export class UsersController {
	constructor(
		private readonly logger: Logger,
		private readonly externalHooks: IExternalHooksClass,
		private readonly internalHooks: IInternalHooksClass,
		private readonly sharedCredentialsRepository: SharedCredentialsRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly activeWorkflowRunner: ActiveWorkflowRunner,
		private readonly roleService: RoleService,
		private readonly userService: UserService,
	) {}

	static ERROR_MESSAGES = {
		CHANGE_ROLE: {
			NO_MEMBER: 'Member cannot change role for any user',
			MISSING_NEW_ROLE_KEY: 'Expected `newRole` to exist',
			MISSING_NEW_ROLE_VALUE: 'Expected `newRole` to have `name` and `scope`',
			NO_USER: 'Target user not found',
			NO_ADMIN_ON_OWNER: 'Admin cannot change role on global owner',
			NO_OWNER_ON_OWNER: 'Owner cannot change role on global owner',
			NO_USER_TO_OWNER: 'Cannot promote user to global owner',
		},
	} as const;

	private async toFindManyOptions(listQueryOptions?: ListQuery.Options) {
		const findManyOptions: FindManyOptions<User> = {};

		if (!listQueryOptions) {
			findManyOptions.relations = ['globalRole', 'authIdentities'];
			return findManyOptions;
		}

		const { filter, select, take, skip } = listQueryOptions;

		if (select) findManyOptions.select = select;
		if (take) findManyOptions.take = take;
		if (skip) findManyOptions.skip = skip;

		if (take && !select) {
			findManyOptions.relations = ['globalRole', 'authIdentities'];
		}

		if (take && select && !select?.id) {
			findManyOptions.select = { ...findManyOptions.select, id: true }; // pagination requires id
		}

		if (filter) {
			const { isOwner, ...otherFilters } = filter;

			findManyOptions.where = otherFilters;

			if (isOwner !== undefined) {
				const ownerRole = await this.roleService.findGlobalOwnerRole();

				findManyOptions.relations = ['globalRole'];
				findManyOptions.where.globalRole = { id: isOwner ? ownerRole.id : Not(ownerRole.id) };
			}
		}

		return findManyOptions;
	}

	private removeSupplementaryFields(
		publicUsers: Array<Partial<PublicUser>>,
		listQueryOptions: ListQuery.Options,
	) {
		const { take, select, filter } = listQueryOptions;

		// remove fields added to satisfy query

		if (take && select && !select?.id) {
			for (const user of publicUsers) delete user.id;
		}

		if (filter?.isOwner) {
			for (const user of publicUsers) delete user.globalRole;
		}

		// remove computed fields (unselectable)

		if (select) {
			for (const user of publicUsers) {
				delete user.isOwner;
				delete user.isPending;
				delete user.signInType;
				delete user.hasRecoveryCodesLeft;
			}
		}

		return publicUsers;
	}

	@Get('/', { middlewares: listQueryMiddleware })
	@RequireGlobalScope('user:list')
	async listUsers(req: ListQuery.Request) {
		const { listQueryOptions } = req;

		const findManyOptions = await this.toFindManyOptions(listQueryOptions);

		const users = await this.userService.findMany(findManyOptions);

		const publicUsers: Array<Partial<PublicUser>> = await Promise.all(
			users.map(async (u) => this.userService.toPublic(u, { withInviteUrl: true })),
		);

		return listQueryOptions
			? this.removeSupplementaryFields(publicUsers, listQueryOptions)
			: publicUsers;
	}

	@Get('/:id/password-reset-link')
	@RequireGlobalScope('user:resetPassword')
	async getUserPasswordResetLink(req: UserRequest.PasswordResetLink) {
		const user = await this.userService.findOneOrFail({
			where: { id: req.params.id },
		});
		if (!user) {
			throw new NotFoundError('User not found');
		}

		const link = this.userService.generatePasswordResetUrl(user);
		return { link };
	}

	@Patch('/:id/settings')
	@RequireGlobalScope('user:update')
	async updateUserSettings(req: UserRequest.UserSettingsUpdate) {
		const payload = plainToInstance(UserSettingsUpdatePayload, req.body);

		const id = req.params.id;

		await this.userService.updateSettings(id, payload);

		const user = await this.userService.findOneOrFail({
			select: ['settings'],
			where: { id },
		});

		return user.settings;
	}

	/**
	 * Delete a user. Optionally, designate a transferee for their workflows and credentials.
	 */
	@Authorized(['global', 'owner'])
	@Delete('/:id')
	@RequireGlobalScope('user:delete')
	async deleteUser(req: UserRequest.Delete) {
		const { id: idToDelete } = req.params;

		if (req.user.id === idToDelete) {
			this.logger.debug(
				'Request to delete a user failed because it attempted to delete the requesting user',
				{ userId: req.user.id },
			);
			throw new BadRequestError('Cannot delete your own user');
		}

		const { transferId } = req.query;

		if (transferId === idToDelete) {
			throw new BadRequestError(
				'Request to delete a user failed because the user to delete and the transferee are the same user',
			);
		}

		const users = await this.userService.findMany({
			where: { id: In([transferId, idToDelete]) },
			relations: ['globalRole'],
		});

		if (!users.length || (transferId && users.length !== 2)) {
			throw new NotFoundError(
				'Request to delete a user failed because the ID of the user to delete and/or the ID of the transferee were not found in DB',
			);
		}

		const userToDelete = users.find((user) => user.id === req.params.id) as User;

		const telemetryData: ITelemetryUserDeletionData = {
			user_id: req.user.id,
			target_user_old_status: userToDelete.isPending ? 'invited' : 'active',
			target_user_id: idToDelete,
		};

		telemetryData.migration_strategy = transferId ? 'transfer_data' : 'delete_data';

		if (transferId) {
			telemetryData.migration_user_id = transferId;
		}

		const [workflowOwnerRole, credentialOwnerRole] = await Promise.all([
			this.roleService.findWorkflowOwnerRole(),
			this.roleService.findCredentialOwnerRole(),
		]);

		if (transferId) {
			const transferee = users.find((user) => user.id === transferId);

			await this.userService.getManager().transaction(async (transactionManager) => {
				// Get all workflow ids belonging to user to delete
				const sharedWorkflowIds = await transactionManager
					.getRepository(SharedWorkflow)
					.find({
						select: ['workflowId'],
						where: { userId: userToDelete.id, roleId: workflowOwnerRole?.id },
					})
					.then((sharedWorkflows) => sharedWorkflows.map(({ workflowId }) => workflowId));

				// Prevents issues with unique key constraints since user being assigned
				// workflows and credentials might be a sharee
				await transactionManager.delete(SharedWorkflow, {
					user: transferee,
					workflowId: In(sharedWorkflowIds),
				});

				// Transfer ownership of owned workflows
				await transactionManager.update(
					SharedWorkflow,
					{ user: userToDelete, role: workflowOwnerRole },
					{ user: transferee },
				);

				// Now do the same for creds

				// Get all workflow ids belonging to user to delete
				const sharedCredentialIds = await transactionManager
					.getRepository(SharedCredentials)
					.find({
						select: ['credentialsId'],
						where: { userId: userToDelete.id, roleId: credentialOwnerRole?.id },
					})
					.then((sharedCredentials) => sharedCredentials.map(({ credentialsId }) => credentialsId));

				// Prevents issues with unique key constraints since user being assigned
				// workflows and credentials might be a sharee
				await transactionManager.delete(SharedCredentials, {
					user: transferee,
					credentialsId: In(sharedCredentialIds),
				});

				// Transfer ownership of owned credentials
				await transactionManager.update(
					SharedCredentials,
					{ user: userToDelete, role: credentialOwnerRole },
					{ user: transferee },
				);

				await transactionManager.delete(AuthIdentity, { userId: userToDelete.id });

				// This will remove all shared workflows and credentials not owned
				await transactionManager.delete(User, { id: userToDelete.id });
			});

			void this.internalHooks.onUserDeletion({
				user: req.user,
				telemetryData,
				publicApi: false,
			});
			await this.externalHooks.run('user.deleted', [await this.userService.toPublic(userToDelete)]);
			return { success: true };
		}

		const [ownedSharedWorkflows, ownedSharedCredentials] = await Promise.all([
			this.sharedWorkflowRepository.find({
				relations: ['workflow'],
				where: { userId: userToDelete.id, roleId: workflowOwnerRole?.id },
			}),
			this.sharedCredentialsRepository.find({
				relations: ['credentials'],
				where: { userId: userToDelete.id, roleId: credentialOwnerRole?.id },
			}),
		]);

		await this.userService.getManager().transaction(async (transactionManager) => {
			const ownedWorkflows = await Promise.all(
				ownedSharedWorkflows.map(async ({ workflow }) => {
					if (workflow.active) {
						// deactivate before deleting
						await this.activeWorkflowRunner.remove(workflow.id);
					}
					return workflow;
				}),
			);
			await transactionManager.remove(ownedWorkflows);
			await transactionManager.remove(ownedSharedCredentials.map(({ credentials }) => credentials));

			await transactionManager.delete(AuthIdentity, { userId: userToDelete.id });
			await transactionManager.delete(User, { id: userToDelete.id });
		});

		void this.internalHooks.onUserDeletion({
			user: req.user,
			telemetryData,
			publicApi: false,
		});

		await this.externalHooks.run('user.deleted', [await this.userService.toPublic(userToDelete)]);
		return { success: true };
	}

	// @TODO: Add scope check `@RequireGlobalScope('user:changeRole')`
	// once this has been merged: https://github.com/n8n-io/n8n/pull/7737
	@Authorized('any')
	@Patch('/:id/role')
	async changeRole(req: UserRequest.ChangeRole) {
		const {
			NO_MEMBER,
			MISSING_NEW_ROLE_KEY,
			MISSING_NEW_ROLE_VALUE,
			NO_ADMIN_ON_OWNER,
			NO_USER_TO_OWNER,
			NO_USER,
			NO_OWNER_ON_OWNER,
		} = UsersController.ERROR_MESSAGES.CHANGE_ROLE;

		if (req.user.globalRole.scope === 'global' && req.user.globalRole.name === 'member') {
			throw new UnauthorizedError(NO_MEMBER);
		}

		const { newRole } = req.body;

		if (!newRole) {
			throw new BadRequestError(MISSING_NEW_ROLE_KEY);
		}

		if (!newRole.name || !newRole.scope) {
			throw new BadRequestError(MISSING_NEW_ROLE_VALUE);
		}

		if (newRole.scope === 'global' && newRole.name === 'owner') {
			throw new UnauthorizedError(NO_USER_TO_OWNER);
		}

		const targetUser = await this.userService.findOne({
			where: { id: req.params.id },
		});

		if (targetUser === null) {
			throw new NotFoundError(NO_USER);
		}

		if (
			req.user.globalRole.scope === 'global' &&
			req.user.globalRole.name === 'admin' &&
			targetUser.globalRole.scope === 'global' &&
			targetUser.globalRole.name === 'owner'
		) {
			throw new UnauthorizedError(NO_ADMIN_ON_OWNER);
		}

		if (
			req.user.globalRole.scope === 'global' &&
			req.user.globalRole.name === 'owner' &&
			targetUser.globalRole.scope === 'global' &&
			targetUser.globalRole.name === 'owner'
		) {
			throw new UnauthorizedError(NO_OWNER_ON_OWNER);
		}

		const roleToSet = await this.roleService.findCached(newRole.scope, newRole.name);

		await this.userService.update(targetUser.id, { globalRole: roleToSet });

		return { success: true };
	}
}
