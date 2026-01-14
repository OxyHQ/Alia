
import { HugeiconsIcon } from '@hugeicons/react'

export function createIcon(icon: any) {
    const IconWrapper = ({ className, ...props }: any) => (
        <HugeiconsIcon icon={icon} className={className} {...props} />
    );
    IconWrapper.displayName = 'HugeIconWrapper';
    return IconWrapper;
}
