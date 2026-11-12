import React from 'react';
import {createRoot} from 'react-dom/client';
import {BloomThemeProvider} from '@oxy.so/bloom/theme';
import {AliaAvatarIcon} from '../../packages/alia-chat/src/components/AliaAvatarIcon';
createRoot(document.getElementById('root')!).render(<BloomThemeProvider><AliaAvatarIcon width={20} height={20}/></BloomThemeProvider>);
