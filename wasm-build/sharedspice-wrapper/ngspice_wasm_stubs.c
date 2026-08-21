/***************************************************************************
 *   Modified (C) 2026 by EasyEDA & JLC Technology Group                      *
 *   chensiyu@sz-jlc.com                                                   *
 *   This program is free software; you can redistribute it and/or modify  *
 *   it under the terms of the GNU General Public License as published by  *
 *   the Free Software Foundation; either version 3 of the License, or     *
 *   (at your option) any later version.                                   *
 *                                                                         *
 *   This program is distributed in the hope that it will be useful,       *
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of        *
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the          *
 *   GNU General Public License for more details.                          *
 *                                                                         *
 *   You should have received a copy of the GNU General Public License     *
 *   along with this program. If not, see <http://www.gnu.org/licenses/>.  *
 ***************************************************************************/
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct IFcardInfo IFcardInfo;

IFcardInfo *INPcardTab[] = { NULL };
int INPnumCards = 0;

char *inputdir = NULL;

int load_osdi(const char *path)
{
	(void)path;
	return 1;
}

int BindCompare(const void *a, const void *b)
{
	const int left = *(const int *)a;
	const int right = *(const int *)b;
	return (left > right) - (left < right);
}

void SMPconvertCOOtoCSC(void *matrix)
{
	(void)matrix;
}

#ifdef __cplusplus
}
#endif
