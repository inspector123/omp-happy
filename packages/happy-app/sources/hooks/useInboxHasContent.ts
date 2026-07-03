import { useFriendRequests, useRequestedFriends, useFeedItems } from '@/sync/storage';
import { useChangelog } from './useChangelog';

// Hook to check if inbox has content to show
export function useInboxHasContent(): boolean {
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();
    const changelog = useChangelog();

    // Show dot if there's any actionable content:
    // - Incoming friend requests (also shown as badge)
    // - Outgoing friend requests pending
    // - Unread changelog entries
    return friendRequests.length > 0 || requestedFriends.length > 0 || (changelog.hasUnread === true);
}