/* ライブラリ課題用のテスト main。c42check.mainFile で指定する (norminette の対象外) */
#include <stdio.h>
#include <stdlib.h>
#include "../libft.h"

int main(void)
{
	char	*s = ft_strdup("42tokyo");

	if (s == NULL || ft_strlen(s) != 7)
		return (1);
	printf("lib ok: %s\n", s);
	free(s);
	return (0);
}
